import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import Groq from "groq-sdk";
import { logger } from "../lib/logger";
import {
  getStoreByToken,
  getHistory,
  appendHistory,
  clearHistory,
  tryLockChat,
  unlockChat,
} from "../lib/cache";
import { tgSend, tgSendPhoto, tgAnswer } from "../lib/tgApi";
import type { InlineKeyboard } from "../lib/tgApi";
import type { ChatMessage } from "../lib/cache";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const router = Router();

// ── Model config ──────────────────────────────────────────────────────────────
const MODEL          = "llama3-70b-8192"; // Groq: smarter tier, still ~sub-second
const MAX_TOKENS     = 80;    // 80 tokens ≈ 25-30 words — enough for short answers
const TEMPERATURE    = 0.2;   // slight warmth for conversational replies
const AI_TIMEOUT_MS  = 8_000; // Groq is sub-second; 8 s is a generous ceiling
const ORDER_MARKER   = "___CREATE_ORDER___";

// Stop sequences — Groq hard-limits to 4 max. Keep the most useful ones.
const STOP_SEQUENCES = ["\n\n", "\n•", "\n-", "Buyurtma bermoqchimisiz"];

// ── Navigation ────────────────────────────────────────────────────────────────
const MAIN_KEYBOARD: InlineKeyboard = [
  [
    { text: "🛍 Katalog", callback_data: "menu:catalog" },
    { text: "📦 Buyurtmalarim", callback_data: "menu:orders" },
  ],
];

const BUY_KEYBOARD: InlineKeyboard = [
  [{ text: "🛒 Buyurtma berish", callback_data: "menu:buy" }],
];

const DETAIL_BUY_KB = (idx: number): InlineKeyboard => [
  [
    { text: "📋 Batafsil", callback_data: `pd:${idx}` },
    { text: "🛒 Buyurtma berish", callback_data: "menu:buy" },
  ],
];

// ─────────────────────────────────────────────────────────────────────────────
// Product helpers
// ─────────────────────────────────────────────────────────────────────────────
interface Product { name: string; price: string; desc: string; }

function parseProducts(contextData: string): Product[] {
  return contextData
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const p = l.split("|").map((s) => s.trim());
      return p.length >= 2 ? { name: p[0], price: p[1], desc: p[2] ?? "" } : null;
    })
    .filter(Boolean) as Product[];
}

/**
 * Returns the matching product AND its catalog index (used for pd:{idx} button).
 * Three-level fuzzy: full-name substring → all-words → majority-words.
 */
function findProduct(
  query: string,
  products: Product[],
): { product: Product; index: number } | null {
  const q = query.toLowerCase().replace(/[?!.,;:'"]/g, " ").replace(/\s+/g, " ").trim();

  for (let i = 0; i < products.length; i++) {
    if (q.includes(products[i].name.toLowerCase())) return { product: products[i], index: i };
  }
  for (let i = 0; i < products.length; i++) {
    const words = products[i].name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (words.length > 0 && words.every((w) => q.includes(w)))
      return { product: products[i], index: i };
  }
  for (let i = 0; i < products.length; i++) {
    const words = products[i].name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (words.length >= 3 && words.filter((w) => q.includes(w)).length >= 2)
      return { product: products[i], index: i };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-processor: enforce 15-word hard cap + strip "Buyurtma bermoqchimisiz?"
// ─────────────────────────────────────────────────────────────────────────────
function clipOutput(text: string): string {
  // Remove the question we now handle as a button
  let t = text
    .replace(/Buyurtma bermoqchimisiz\??/gi, "")
    .replace(/Вы хотите сделать заказ\??/gi, "")
    .trim()
    .replace(/\s{2,}/g, " ");

  // Enforce 15-word cap
  const words = t.split(/\s+/);
  if (words.length > 15) t = words.slice(0, 15).join(" ").replace(/[,.]?$/, "") + ".";

  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fast-path pre-processor
// Handles greetings, list queries, and product searches with zero LLM.
// Returns { reply, keyboard } or null.
// ─────────────────────────────────────────────────────────────────────────────
const GREETING_RE = /^(salom|assalom|assalomu alaykum|yaxshimisiz|hi|hey|hello|привет|здравствуй|здравствуйте|добры[йе]|доброе)/i;

const LIST_PATTERNS_UZ = ["nima bor", "nimalar bor", "ro'yxat", "mahsulotlar", "barcha mahsulot", "hammasi", "tovarlar", "ассортимент"];
const LIST_PATTERNS_RU = ["что есть", "список", "каталог", "что имеется", "все товары"];

const SEARCH_UZ = ["bormi", "borm", "mavjudmi", "qancha", "narxi", "narx"];
const SEARCH_RU = ["есть", "имеется", "стоит", "цена", "почем"];

interface FastResult { reply: string; keyboard?: InlineKeyboard; }

function fastPath(
  userText: string,
  storeName: string,
  products: Product[],
): FastResult | null {
  const lower = userText.toLowerCase().trim();

  // ── Greeting (≤ 30 chars, starts with known pattern) ─────────────────────
  if (lower.length <= 30 && GREETING_RE.test(lower)) {
    return {
      reply: `${storeName} — nima qiziqtiradi?`,
      keyboard: MAIN_KEYBOARD,
    };
  }

  // ── List request → return catalog immediately ─────────────────────────────
  if (
    LIST_PATTERNS_UZ.some((p) => lower.includes(p)) ||
    LIST_PATTERNS_RU.some((p) => lower.includes(p))
  ) {
    return null; // signal the caller to open the catalog screen directly
  }

  // ── Direct product search ─────────────────────────────────────────────────
  const isSearch =
    lower.length < 80 &&
    (SEARCH_UZ.some((s) => lower.includes(s)) || SEARCH_RU.some((s) => lower.includes(s)));

  if (isSearch || lower.length < 50) {
    const hit = findProduct(lower, products);
    if (hit) {
      return {
        reply: `${hit.product.name} — ${hit.product.price}.`,
        keyboard: DETAIL_BUY_KB(hit.index),
      };
    }
    if (isSearch) {
      return { reply: `Bu mahsulot yo'q.`, keyboard: MAIN_KEYBOARD };
    }
  }

  return null;
}

/**
 * True when the last assistant message was collecting an order field.
 * In this state fast-path is skipped — the LLM must continue the flow.
 */
function isCollectingOrder(botToken: string, chatId: number): boolean {
  const history = getHistory(botToken, chatId);
  // findLast is ES2023; use reverse-iteration for ES2022 target compatibility
  let last: ChatMessage | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "assistant") { last = history[i]; break; }
  }
  if (!last) return false;
  const c = last.content.toLowerCase();
  return (
    c.includes("ismingiz") || c.includes("telefon") || c.includes("manzil") ||
    c.includes("ваше имя") || c.includes("номер") || c.includes("адрес")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt — database-terminal style, ~40 tokens
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(storeName: string, catalog: string): string {
  return [
    `You are a helpful assistant for "${storeName}" shop.`,
    ``,
    `PRODUCTS:\n${catalog}`,
    ``,
    `RULES:`,
    `- For product questions: reply "[Name] — [Price]." One line only.`,
    `- For simple questions ("who are you?", "recommend something", greetings): answer in ONE short sentence in the user's language. Be friendly.`,
    `- No markdown, no bullet points, no "albatta", no filler phrases.`,
    `- Default language: Uzbek. Use Russian if user writes in Russian.`,
    ``,
    `ORDER COLLECTION (only when user wants to buy):`,
    `- Collect one field per message: "Ismingiz?" then "Telefon?" then "Manzil?"`,
    `- When all 3 collected, output exactly:`,
    `${ORDER_MARKER} {"name":"...","phone":"...","address":"...","items":"...","total":0}`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Static screens
// ─────────────────────────────────────────────────────────────────────────────
async function handleStart(
  botToken: string, chatId: number, firstName: string, storeName: string,
): Promise<void> {
  await tgSend(
    botToken, chatId,
    `👋 <b>${firstName}</b>, ${storeName} do'koniga xush kelibsiz!`,
    MAIN_KEYBOARD,
  );
}

async function handleCatalog(
  botToken: string, chatId: number, products: Product[], storeName: string,
): Promise<void> {
  if (!products.length) {
    await tgSend(botToken, chatId, "Katalog hozir mavjud emas.", MAIN_KEYBOARD);
    return;
  }
  const list = products.map((p, i) => `${i + 1}. <b>${p.name}</b> — ${p.price}`).join("\n");
  await tgSend(
    botToken, chatId,
    `🛍 <b>${storeName}</b>\n\n${list}`,
    [[{ text: "🔙 Orqaga", callback_data: "menu:start" }]],
  );
}

async function handleMyOrders(botToken: string, chatId: number, fromId: number): Promise<void> {
  const backBtn: InlineKeyboard = [[{ text: "🔙 Orqaga", callback_data: "menu:start" }]];
  const orders = await db.query.ordersTable.findMany({
    where: eq(ordersTable.customerTgId, BigInt(fromId)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 5,
  });
  if (!orders.length) {
    await tgSend(botToken, chatId, "📦 Buyurtmalar yo'q.", backBtn);
    return;
  }
  const STATUS: Record<string, string> = {
    PENDING: "🕐 Kutilmoqda", PAID: "✅ To'langan",
    SHIPPED: "🚚 Yetkazilmoqda", DELIVERED: "📬 Yetkazildi", CANCELLED: "❌ Bekor",
  };
  const lines = orders.map((o, i) => {
    const items =
      typeof o.orderItems === "object" && o.orderItems !== null && "items" in o.orderItems
        ? String((o.orderItems as Record<string, unknown>).items)
        : "Mahsulot";
    const date = new Date(o.createdAt).toLocaleDateString("uz-UZ");
    return `${i + 1}. <b>${items}</b>\n   💰 ${o.totalPrice} so'm | ${STATUS[o.status] ?? o.status} | 📅 ${date}`;
  });
  await tgSend(botToken, chatId, `📦 <b>Buyurtmalaringiz:</b>\n\n${lines.join("\n\n")}`, backBtn);
}

/** Show full product detail from catalog by index — zero LLM. */
async function handleProductDetail(
  botToken: string, chatId: number, products: Product[], idx: number,
): Promise<void> {
  const p = products[idx];
  if (!p) return;
  const text = p.desc
    ? `<b>${p.name}</b> — ${p.price}\n\n${p.desc}`
    : `<b>${p.name}</b> — ${p.price}`;
  await tgSend(botToken, chatId, text, [
    [{ text: "🛒 Buyurtma berish", callback_data: "menu:buy" }],
    [{ text: "🔙 Orqaga", callback_data: "menu:start" }],
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Order extraction
// ─────────────────────────────────────────────────────────────────────────────
interface OrderData { name: string; phone: string; address: string; items: string; total: number; }

function extractOrder(aiText: string): { reply: string; order: OrderData | null } {
  const idx = aiText.indexOf(ORDER_MARKER);
  if (idx === -1) return { reply: aiText.trim(), order: null };
  const reply = aiText.slice(0, idx).trim();
  const match = aiText.slice(idx + ORDER_MARKER.length).trim().match(/\{[\s\S]*?\}/);
  if (!match) return { reply, order: null };
  try {
    const order = JSON.parse(match[0]) as OrderData;
    if (!order.name || !order.phone || !order.address) return { reply, order: null };
    return { reply, order };
  } catch { return { reply, order: null }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main text message handler
// ─────────────────────────────────────────────────────────────────────────────
async function handleUserMessage(
  botToken: string,
  chatId: number,
  fromId: number,
  userText: string,
  storeId: string,
  storeOwnerId: string,
  storeName: string,
  contextData: string,
  products: Product[],
): Promise<void> {
  // ── List-query shortcut: open catalog directly ────────────────────────────
  const lower = userText.toLowerCase().trim();
  const isListQuery =
    LIST_PATTERNS_UZ.some((p) => lower.includes(p)) ||
    LIST_PATTERNS_RU.some((p) => lower.includes(p));
  if (isListQuery && !isCollectingOrder(botToken, chatId)) {
    await handleCatalog(botToken, chatId, products, storeName);
    return;
  }

  // ── Fast-path: zero LLM ───────────────────────────────────────────────────
  if (!isCollectingOrder(botToken, chatId)) {
    const fast = fastPath(userText, storeName, products);
    if (fast) {
      appendHistory(botToken, chatId, "user", userText);
      appendHistory(botToken, chatId, "assistant", fast.reply);
      await tgSend(botToken, chatId, fast.reply, fast.keyboard);
      return;
    }
  }

  // ── LLM path ──────────────────────────────────────────────────────────────
  if (!tryLockChat(botToken, chatId)) {
    await tgSend(botToken, chatId, "⏳ Kuting...");
    return;
  }

  try {
    appendHistory(botToken, chatId, "user", userText);
    const history = getHistory(botToken, chatId).slice(-4); // last 2 exchanges only

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    let aiText: string;
    try {
      const res = await groq.chat.completions.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          stop: STOP_SEQUENCES,
          messages: [
            { role: "system", content: buildSystemPrompt(storeName, contextData) },
            ...history,
          ],
        },
        { signal: controller.signal },
      );
      aiText = (res.choices[0]?.message?.content ?? "").trim();
      console.log("AI Response:", aiText || "(empty)");
    } finally {
      clearTimeout(timer);
    }

    if (!aiText) {
      await tgSend(botToken, chatId, "Qayta yuboring.");
      return;
    }

    const { reply, order } = extractOrder(aiText);

    if (order) {
      // ── Order committed ────────────────────────────────────────────────────
      await db.insert(ordersTable).values({
        storeId,
        customerTgId: BigInt(fromId),
        customerName: order.name,
        customerPhone: order.phone,
        customerAddress: order.address,
        orderItems: { items: order.items },
        totalPrice: String(order.total ?? 0),
        status: "PENDING",
      });
      logger.info({ storeId, customer: order.name }, "Order committed");
      clearHistory(botToken, chatId);

      // Notify owner — fire-and-forget
      db.query.usersTable
        .findFirst({ where: eq(usersTable.id, storeOwnerId) })
        .then((owner) => {
          const pt = process.env.PLATFORM_BOT_TOKEN;
          if (owner && pt) {
            tgSend(
              pt, Number(owner.telegramId),
              `🔔 <b>YANGI BUYURTMA!</b>\n\n🏪 ${storeName}\n👤 ${order.name}\n📞 ${order.phone}\n📍 ${order.address}\n🛒 ${order.items}\n💰 ${order.total} so'm`,
            ).catch((e) => logger.error({ e }, "Owner notify failed"));
          }
        })
        .catch((e) => logger.error({ e }, "Owner lookup failed"));

      const customerReply = reply || "✅ Buyurtma qabul qilindi!";
      await tgSend(botToken, chatId, customerReply, [
        [{ text: "📦 Buyurtmalarim", callback_data: "menu:orders" }],
        [{ text: "🏠 Bosh menyu", callback_data: "menu:start" }],
      ]);
      appendHistory(botToken, chatId, "assistant", customerReply);
    } else {
      // ── Regular AI reply: clip + attach buy button ─────────────────────────
      const clipped = clipOutput(reply);
      appendHistory(botToken, chatId, "assistant", clipped);
      // Only add buy button when NOT in the middle of order field collection
      const kb = isCollectingOrder(botToken, chatId) ? undefined : BUY_KEYBOARD;
      await tgSend(botToken, chatId, clipped, kb);
    }
  } catch (err) {
    const e = err as Error & { status?: number; error?: unknown };
    const detail = e.name === "AbortError"
      ? "timeout"
      : { name: e.name, message: e.message, status: e.status, body: e.error };
    logger.warn({ err: detail }, "AI failed");
    console.error("AI Error:", e.name, e.message, e.status ?? "");
    await tgSend(botToken, chatId, "Qayta urinib ko'ring.").catch(() => {});
  } finally {
    unlockChat(botToken, chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express webhook route
// ─────────────────────────────────────────────────────────────────────────────
router.post("/webhook/store/:bot_token", async (req, res) => {
  res.sendStatus(200); // ACK Telegram immediately

  const { bot_token } = req.params as { bot_token: string };
  const body = req.body as Record<string, unknown>;

  try {
    const store = await getStoreByToken(bot_token);
    if (!store || !store.isActive) return;

    const products = parseProducts(store.contextData);

    // ── Callback query ─────────────────────────────────────────────────────
    const cbq = body.callback_query as Record<string, unknown> | undefined;
    if (cbq) {
      const cbId   = cbq.id as string;
      const data   = (cbq.data as string | undefined) ?? "";
      const cbChat = (cbq.message as Record<string, unknown>)?.chat as Record<string, unknown> | undefined;
      const cbFrom = cbq.from as Record<string, unknown> | undefined;
      const chatId = cbChat?.id as number | undefined;
      const fromId = cbFrom?.id as number | undefined;
      if (!chatId || !data) return;

      await tgAnswer(bot_token, cbId);

      if (data === "menu:start") {
        await handleStart(bot_token, chatId, String(cbFrom?.first_name ?? ""), store.storeName);
      } else if (data === "menu:catalog") {
        await handleCatalog(bot_token, chatId, products, store.storeName);
      } else if (data === "menu:orders") {
        await handleMyOrders(bot_token, chatId, fromId ?? chatId);
      } else if (data === "menu:buy") {
        // Start order collection without touching the LLM
        const q = "Ismingiz?";
        appendHistory(bot_token, chatId, "assistant", q);
        await tgSend(bot_token, chatId, q);
      } else if (data.startsWith("pd:")) {
        // Product detail — no LLM, just catalog lookup by index
        const idx = parseInt(data.slice(3), 10);
        if (!Number.isNaN(idx)) await handleProductDetail(bot_token, chatId, products, idx);
      }
      return;
    }

    // ── Regular message ────────────────────────────────────────────────────
    const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
    if (!message) return;
    const chatId    = ((message.chat as Record<string, unknown>)?.id as number) ?? 0;
    const userText  = ((message.text as string | undefined) ?? "").trim();
    const fromId    = ((message.from as Record<string, unknown>)?.id as number) ?? 0;
    const firstName = String((message.from as Record<string, unknown>)?.first_name ?? "");
    if (!chatId || !userText) return;

    const lc = userText.toLowerCase();
    if (userText === "/start" || lc === "salom" || lc === "привет" || lc === "start") {
      await handleStart(bot_token, chatId, firstName, store.storeName);
      return;
    }
    if (userText === "/catalog") { await handleCatalog(bot_token, chatId, products, store.storeName); return; }
    if (userText === "/orders")  { await handleMyOrders(bot_token, chatId, fromId); return; }

    await handleUserMessage(
      bot_token, chatId, fromId, userText,
      store.id, store.ownerId, store.storeName, store.contextData, products,
    );
  } catch (err) {
    logger.error({ err }, "Store webhook fatal error");
    try {
      const msg    = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
      const chatId = ((msg?.chat as Record<string, unknown>)?.id as number) ?? 0;
      if (chatId) await tgSend(bot_token, chatId, "Texnik muammo. Qayta urinib ko'ring.");
    } catch { /* ignore */ }
  }
});

export { tgSendPhoto };
export default router;
