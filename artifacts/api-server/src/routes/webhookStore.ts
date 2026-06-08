import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
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

const router = Router();

// ── Model config ─────────────────────────────────────────────────────────────
// 7B model is ~8× faster than 72B while still capable for structured sales chat.
const MODEL = "Qwen/Qwen2.5-7B-Instruct";
const MAX_TOKENS = 100;      // sales answers never need more than ~80 tokens
const TEMPERATURE = 0.2;     // low = deterministic, fast decode, no "thinking"
const ORDER_MARKER = "___CREATE_ORDER___";
const AI_TIMEOUT_MS = 15_000; // hard-kill AI call after 15 s

// ── Navigation ────────────────────────────────────────────────────────────────
const MAIN_KEYBOARD: InlineKeyboard = [
  [
    { text: "🛍 Katalog", callback_data: "menu:catalog" },
    { text: "📦 Buyurtmalarim", callback_data: "menu:orders" },
  ],
];

// ─────────────────────────────────────────────────────────────────────────────
// Catalog product type
// ─────────────────────────────────────────────────────────────────────────────
interface Product { name: string; price: string; desc: string; }

/** Parse `Name | Price | Desc` catalog lines into structured products. */
function parseProducts(contextData: string): Product[] {
  return contextData
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split("|").map((p) => p.trim());
      return parts.length >= 2
        ? { name: parts[0], price: parts[1], desc: parts[2] ?? "" }
        : null;
    })
    .filter(Boolean) as Product[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fast-path pre-processor
//
// Handles greetings and direct product searches entirely in-process —
// zero LLM round-trip, zero network call. Returns a ready reply string or
// null if the message needs the LLM.
// ─────────────────────────────────────────────────────────────────────────────

const GREETING_PATTERNS = [
  "assalom", "assalomu alaykum", "salom alik", "yaxshimisiz",
  "hi", "hey", "hello",
  "привет", "здравствуй", "здравствуйте", "добрый", "доброе",
];

const SEARCH_SUFFIXES_UZ = ["bormi", "borm", "bormi?", "mavjudmi", "borm?", "bormi!", "qancha", "narxi"];
const SEARCH_SUFFIXES_RU = ["есть", "имеется", "стоит", "цена"];

/**
 * Fuzzy product match: substring match on full name, then word-level match.
 * Conservative — only fires for unambiguous hits.
 */
function findProduct(query: string, products: Product[]): Product | null {
  const q = query.toLowerCase().replace(/[?!.,;:'"]/g, " ").replace(/\s+/g, " ").trim();

  // 1. Full name substring
  for (const p of products) {
    if (q.includes(p.name.toLowerCase())) return p;
  }

  // 2. Every word in product name (longer than 3 chars) appears in query
  for (const p of products) {
    const nameWords = p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (nameWords.length > 0 && nameWords.every((w) => q.includes(w))) return p;
  }

  // 3. At least 2 words of product name match (for multi-word names ≥ 3 words)
  for (const p of products) {
    const nameWords = p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (nameWords.length >= 3 && nameWords.filter((w) => q.includes(w)).length >= 2) return p;
  }

  return null;
}

/**
 * Returns a fast reply string (bypassing LLM), or `null` if LLM is needed.
 * Only fires when the user is NOT in the middle of order collection.
 */
function fastPath(
  userText: string,
  storeName: string,
  products: Product[],
): string | null {
  const lower = userText.toLowerCase().trim();

  // ── Greeting ───────────────────────────────────────────────────────────────
  // Only for very short messages to avoid false-positives inside product queries
  if (lower.length <= 30 && GREETING_PATTERNS.some((g) => lower.includes(g))) {
    return `${storeName} do'koniga xush kelibsiz! Qaysi mahsulot qiziqtiradi?`;
  }

  // ── Direct product lookup ──────────────────────────────────────────────────
  // Trigger: message contains a search suffix OR is a short direct product name
  const isSearchIntent =
    lower.length < 80 &&
    (SEARCH_SUFFIXES_UZ.some((s) => lower.includes(s)) ||
      SEARCH_SUFFIXES_RU.some((s) => lower.includes(s)));

  if (isSearchIntent || lower.length < 40) {
    const hit = findProduct(lower, products);
    if (hit) {
      const desc = hit.desc ? ` ${hit.desc.slice(0, 80)}.` : "";
      // Deliberately no markdown — just clean text
      return `Ha, ${hit.name} bor — ${hit.price}.${desc} Buyurtma bermoqchimisiz?`;
    }
    // Confident search with no match → tell user immediately, no LLM needed
    if (isSearchIntent) {
      return `Hozircha ${storeName}da bu mahsulot yo'q. Boshqa nima kerak?`;
    }
  }

  return null; // needs LLM
}

/**
 * Returns true if the last assistant message is in the middle of collecting
 * order fields (name / phone / address). In that state we must always go to
 * the LLM so it can continue the structured collection flow.
 */
function isCollectingOrder(botToken: string, chatId: number): boolean {
  const history = getHistory(botToken, chatId);
  const last = history.findLast((m) => m.role === "assistant");
  if (!last) return false;
  const c = last.content.toLowerCase();
  return (
    c.includes("ismingiz") ||
    c.includes("telefon") ||
    c.includes("manzil") ||
    c.includes("ваше имя") ||
    c.includes("номер") ||
    c.includes("адрес")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt — minimal, no markdown, 2-sentence cap
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(storeName: string, catalog: string): string {
  return [
    `You are a sales assistant for "${storeName}". Be brief and friendly.`,
    `PRODUCTS:\n${catalog}`,
    `STRICT RULES:`,
    `- Plain text only. No markdown, asterisks, bullet points, or headers.`,
    `- Every reply must be 1-2 sentences maximum. Never more.`,
    `- Product query: give name + price + one feature, then ask "Buyurtma bermoqchimisiz?"`,
    `- Product not in list: suggest the closest available item.`,
    `- Match user's language (Uzbek or Russian). No other languages.`,
    `- Order collection: ask exactly ONE field per reply: name → phone → address.`,
    `- When you have all 3 fields, append this exact marker at the END of your reply:`,
    `${ORDER_MARKER} {"name":"...","phone":"...","address":"...","items":"...","total":0}`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Welcome / Catalog / Orders screens
// ─────────────────────────────────────────────────────────────────────────────
async function handleStart(
  botToken: string, chatId: number, firstName: string, storeName: string,
): Promise<void> {
  await tgSend(
    botToken, chatId,
    `👋 Salom, <b>${firstName}</b>!\n\n<b>${storeName}</b> do'koniga xush kelibsiz.\n` +
    `Mahsulotlar haqida savol bering yoki bo'limni tanlang:`,
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
    `🛍 <b>${storeName}</b>\n\n${list}\n\n💬 Biror mahsulot haqida batafsil so'rang.`,
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
    await tgSend(botToken, chatId, "📦 Sizda hali buyurtmalar yo'q.", backBtn);
    return;
  }
  const statusLabel: Record<string, string> = {
    PENDING: "🕐 Kutilmoqda", PAID: "✅ To'langan",
    SHIPPED: "🚚 Yetkazilmoqda", DELIVERED: "📬 Yetkazildi", CANCELLED: "❌ Bekor",
  };
  const lines = orders.map((o, i) => {
    const items =
      typeof o.orderItems === "object" && o.orderItems !== null && "items" in o.orderItems
        ? String((o.orderItems as Record<string, unknown>).items)
        : "Mahsulot";
    const date = new Date(o.createdAt).toLocaleDateString("uz-UZ");
    return `${i + 1}. <b>${items}</b>\n   💰 ${o.totalPrice} so'm  |  ${statusLabel[o.status] ?? o.status}  |  📅 ${date}`;
  });
  await tgSend(botToken, chatId, `📦 <b>Oxirgi buyurtmalaringiz:</b>\n\n${lines.join("\n\n")}`, backBtn);
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
// Main message handler
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
): Promise<void> {
  const products = parseProducts(contextData);

  // ── Fast-path (no LLM) ────────────────────────────────────────────────────
  if (!isCollectingOrder(botToken, chatId)) {
    const quickReply = fastPath(userText, storeName, products);
    if (quickReply) {
      appendHistory(botToken, chatId, "user", userText);
      appendHistory(botToken, chatId, "assistant", quickReply);
      await tgSend(botToken, chatId, quickReply);
      return;
    }
  }

  // ── LLM path ─────────────────────────────────────────────────────────────
  if (!tryLockChat(botToken, chatId)) {
    await tgSend(botToken, chatId, "⏳ Avvalgi xabar ishlanmoqda. Biroz kuting...");
    return;
  }

  try {
    appendHistory(botToken, chatId, "user", userText);

    // Context trim: system prompt + last 4 messages (= 2 exchanges) only
    // Fewer tokens = faster time-to-first-token
    const trimmedHistory = getHistory(botToken, chatId).slice(-4);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    let aiText: string;
    try {
      const response = await openai.chat.completions.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          messages: [
            { role: "system", content: buildSystemPrompt(storeName, contextData) },
            ...trimmedHistory,
          ],
        },
        { signal: controller.signal },
      );
      aiText = (response.choices[0]?.message?.content ?? "").trim();
    } finally {
      clearTimeout(timer);
    }

    if (!aiText) {
      await tgSend(botToken, chatId, "Kechirasiz, qayta yuboring.");
      return;
    }

    const { reply, order } = extractOrder(aiText);

    if (order) {
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

      // Notify store owner — fire-and-forget, doesn't block customer reply
      db.query.usersTable
        .findFirst({ where: eq(usersTable.id, storeOwnerId) })
        .then((owner) => {
          const platformToken = process.env.PLATFORM_BOT_TOKEN;
          if (owner && platformToken) {
            tgSend(
              platformToken,
              Number(owner.telegramId),
              `🔔 <b>YANGI BUYURTMA!</b>\n\n🏪 ${storeName}\n👤 ${order.name}\n📞 ${order.phone}\n📍 ${order.address}\n🛒 ${order.items}\n💰 ${order.total} so'm`,
            ).catch((e) => logger.error({ e }, "Owner notify failed"));
          }
        })
        .catch((e) => logger.error({ e }, "Owner lookup failed"));

      const customerReply = reply || "✅ Buyurtmangiz qabul qilindi! Tez orada bog'lanamiz. Rahmat!";
      await tgSend(botToken, chatId, customerReply, [
        [{ text: "📦 Buyurtmalarimni ko'rish", callback_data: "menu:orders" }],
        [{ text: "🏠 Bosh menyu", callback_data: "menu:start" }],
      ]);
      appendHistory(botToken, chatId, "assistant", customerReply);
    } else {
      appendHistory(botToken, chatId, "assistant", aiText);
      await tgSend(botToken, chatId, aiText);
    }
  } catch (err) {
    const isTimeout = (err as Error).name === "AbortError";
    logger.warn({ err: isTimeout ? "timeout" : err }, "AI call failed");
    await tgSend(botToken, chatId, "Kechirasiz, qayta urinib ko'ring.").catch(() => {});
  } finally {
    unlockChat(botToken, chatId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express webhook route
// ─────────────────────────────────────────────────────────────────────────────
router.post("/webhook/store/:bot_token", async (req, res) => {
  res.sendStatus(200); // ACK Telegram immediately — all processing is async

  const { bot_token } = req.params as { bot_token: string };
  const body = req.body as Record<string, unknown>;

  try {
    const store = await getStoreByToken(bot_token); // cache-first, no DB hit on repeat
    if (!store || !store.isActive) return;

    const products = parseProducts(store.contextData); // O(n), n<100, negligible

    // ── Callback query ────────────────────────────────────────────────────
    const cbq = body.callback_query as Record<string, unknown> | undefined;
    if (cbq) {
      const cbId = cbq.id as string;
      const data = (cbq.data as string | undefined) ?? "";
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
      }
      return;
    }

    // ── Regular message ───────────────────────────────────────────────────
    const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
    if (!message) return;
    const chatId = ((message.chat as Record<string, unknown>)?.id as number) ?? 0;
    const userText = ((message.text as string | undefined) ?? "").trim();
    const fromId = ((message.from as Record<string, unknown>)?.id as number) ?? 0;
    const firstName = String((message.from as Record<string, unknown>)?.first_name ?? "");
    if (!chatId || !userText) return;

    const lower = userText.toLowerCase();
    if (userText === "/start" || lower === "salom" || lower === "привет" || lower === "start") {
      await handleStart(bot_token, chatId, firstName, store.storeName);
      return;
    }
    if (userText === "/catalog") { await handleCatalog(bot_token, chatId, products, store.storeName); return; }
    if (userText === "/orders") { await handleMyOrders(bot_token, chatId, fromId); return; }

    await handleUserMessage(
      bot_token, chatId, fromId, userText,
      store.id, store.ownerId, store.storeName, store.contextData,
    );
  } catch (err) {
    logger.error({ err }, "Store webhook fatal error");
    try {
      const msg = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
      const chatId = ((msg?.chat as Record<string, unknown>)?.id as number) ?? 0;
      if (chatId) await tgSend(bot_token, chatId, "Kechirasiz, texnik muammo. Qayta urinib ko'ring.");
    } catch { /* ignore */ }
  }
});

export { tgSendPhoto };
export default router;
