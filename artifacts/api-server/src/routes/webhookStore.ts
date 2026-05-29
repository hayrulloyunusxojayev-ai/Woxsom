import { Router } from "express";
import { db } from "@workspace/db";
import { storesTable, ordersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";

const router = Router();

const MODEL = "Qwen/Qwen2.5-72B-Instruct";
const ORDER_MARKER = "___CREATE_ORDER___";

// ---------------------------------------------------------------------------
// Conversation history (in-memory)
// ---------------------------------------------------------------------------
interface ChatMessage { role: "user" | "assistant"; content: string; }
const conversationHistory = new Map<string, ChatMessage[]>();

function historyKey(botToken: string, chatId: number): string { return `${botToken}:${chatId}`; }
function getHistory(botToken: string, chatId: number): ChatMessage[] {
  const key = historyKey(botToken, chatId);
  if (!conversationHistory.has(key)) conversationHistory.set(key, []);
  return conversationHistory.get(key)!;
}
function appendHistory(botToken: string, chatId: number, role: "user" | "assistant", content: string): void {
  getHistory(botToken, chatId).push({ role, content });
}
function clearHistory(botToken: string, chatId: number): void {
  conversationHistory.delete(historyKey(botToken, chatId));
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------
type InlineKeyboard = { text: string; callback_data: string }[][];

async function sendMessage(
  botToken: string,
  chatId: number | bigint,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: Number(chatId),
      text: text.slice(0, 4096),
      parse_mode: "HTML",
    };
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) logger.warn({ chatId, body: await res.text() }, "Telegram sendMessage failed");
  } catch (err) {
    logger.error({ err, chatId }, "sendMessage network error");
  }
}

async function sendPhoto(
  botToken: string,
  chatId: number | bigint,
  photoUrl: string,
  caption: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: Number(chatId),
      photo: photoUrl,
      caption: caption.slice(0, 1024),
      parse_mode: "HTML",
    };
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) logger.warn({ chatId, body: await res.text() }, "Telegram sendPhoto failed");
  } catch (err) {
    logger.error({ err, chatId }, "sendPhoto network error");
  }
}

async function answerCallbackQuery(botToken: string, id: string, text?: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text }),
    });
  } catch (err) {
    logger.error({ err }, "answerCallbackQuery error");
  }
}

// ---------------------------------------------------------------------------
// Navigation keyboard
// ---------------------------------------------------------------------------
const MAIN_KEYBOARD: InlineKeyboard = [
  [
    { text: "🛍 Katalog", callback_data: "menu:catalog" },
    { text: "📦 Buyurtmalarim", callback_data: "menu:orders" },
  ],
  [{ text: "💬 AI Maslahatchi", callback_data: "menu:chat" }],
];

// ---------------------------------------------------------------------------
// Welcome screen
// ---------------------------------------------------------------------------
async function handleStart(
  botToken: string,
  chatId: number,
  firstName: string,
  store: typeof storesTable.$inferSelect
): Promise<void> {
  const text =
    `👋 Salom, <b>${firstName}</b>!\n\n` +
    `<b>${store.storeName}</b> do'koniga xush kelibsiz.\n` +
    `Men sizning shaxsiy savdo maslahatchimanman — mahsulotlar haqida so'rang yoki quyidagi bo'limni tanlang:`;
  await sendMessage(botToken, chatId, text, MAIN_KEYBOARD);
}

// ---------------------------------------------------------------------------
// Catalog — formatted product list, no raw dump
// ---------------------------------------------------------------------------
async function handleCatalog(
  botToken: string,
  chatId: number,
  store: typeof storesTable.$inferSelect
): Promise<void> {
  const lines = store.contextData
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const products = lines
    .map((l) => {
      const parts = l.split("|").map((p) => p.trim());
      if (parts.length < 2) return null;
      return { name: parts[0], price: parts[1] };
    })
    .filter(Boolean) as { name: string; price: string }[];

  if (products.length === 0) {
    await sendMessage(botToken, chatId, "Katalog hozir mavjud emas. Keyinroq kiring.", MAIN_KEYBOARD);
    return;
  }

  const productLines = products.map((p, i) => `${i + 1}. <b>${p.name}</b> — ${p.price}`).join("\n");
  const text =
    `🛍 <b>${store.storeName} — Mahsulotlar</b>\n\n` +
    `${productLines}\n\n` +
    `💬 Biror mahsulot haqida batafsil ma'lumot olish uchun nomini yozing.`;

  const keyboard: InlineKeyboard = [
    [{ text: "💬 Savol berish", callback_data: "menu:chat" }],
    [{ text: "🔙 Orqaga", callback_data: "menu:start" }],
  ];
  await sendMessage(botToken, chatId, text, keyboard);
}

// ---------------------------------------------------------------------------
// My Orders
// ---------------------------------------------------------------------------
async function handleMyOrders(
  botToken: string,
  chatId: number,
  fromId: number
): Promise<void> {
  const orders = await db.query.ordersTable.findMany({
    where: eq(ordersTable.customerTgId, BigInt(fromId)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 5,
  });

  const backKeyboard: InlineKeyboard = [[{ text: "🔙 Orqaga", callback_data: "menu:start" }]];

  if (!orders.length) {
    await sendMessage(
      botToken, chatId,
      "📦 Sizda hali buyurtmalar yo'q.\n\nBiror mahsulot haqida so'rash uchun AI Maslahatchi bilan bog'laning!",
      backKeyboard
    );
    return;
  }

  const statusEmoji: Record<string, string> = {
    PENDING: "🕐 Kutilmoqda",
    PAID: "✅ To'langan",
    SHIPPED: "🚚 Yetkazilmoqda",
    DELIVERED: "📬 Yetkazildi",
    CANCELLED: "❌ Bekor qilindi",
  };

  const lines = orders.map((o, i) => {
    const items = o.orderItems && typeof o.orderItems === "object" && "items" in o.orderItems
      ? String((o.orderItems as Record<string, unknown>).items)
      : "Mahsulot";
    const status = statusEmoji[o.status] ?? o.status;
    const date = new Date(o.createdAt).toLocaleDateString("uz-UZ");
    return `${i + 1}. <b>${items}</b>\n   💰 ${o.totalPrice} so'm  |  ${status}  |  📅 ${date}`;
  });

  await sendMessage(
    botToken, chatId,
    `📦 <b>Oxirgi buyurtmalaringiz:</b>\n\n${lines.join("\n\n")}`,
    backKeyboard
  );
}

// ---------------------------------------------------------------------------
// Order extraction
// ---------------------------------------------------------------------------
interface OrderData { name: string; phone: string; address: string; items: string; total: number; }

function extractOrder(aiText: string): { reply: string; order: OrderData | null } {
  const idx = aiText.indexOf(ORDER_MARKER);
  if (idx === -1) return { reply: aiText.trim(), order: null };
  const reply = aiText.slice(0, idx).trim();
  const after = aiText.slice(idx + ORDER_MARKER.length).trim();
  const match = after.match(/\{[\s\S]*?\}/);
  if (!match) { logger.warn({ after }, "ORDER_MARKER found but no JSON"); return { reply, order: null }; }
  try {
    const order = JSON.parse(match[0]) as OrderData;
    if (!order.name || !order.phone || !order.address) {
      logger.warn({ order }, "Order JSON missing required fields");
      return { reply, order: null };
    }
    return { reply, order };
  } catch {
    logger.warn({ raw: match[0] }, "Failed to parse order JSON");
    return { reply, order: null };
  }
}

// ---------------------------------------------------------------------------
// System prompt — Premium Sales Consultant
// ---------------------------------------------------------------------------
function buildSystemPrompt(storeName: string, catalog: string): string {
  return (
    `Siz "${storeName}" do'konining premium savdo maslahatchidasiz. ` +
    `Muloqotingiz qisqa, aniq va xushmuomala bo'lsin.\n\n` +
    `MAHSULOTLAR (bu sizning bilim bazangiz — mijozga to'liq ro'yxatni yubormang):\n${catalog}\n\n` +
    `QOIDALAR:\n` +
    `1. Birinchi xabarda bir marta salomlashing. Keyingi xabarlarda salomlashmang.\n` +
    `2. Mahsulot haqida so'ralganda FAQAT: Nomi, Narxi, 1-2 ta asosiy xususiyat — 2-3 jumla yozing.\n` +
    `3. Har bir mahsulot tavsifidan keyin darhol so'rang: "Buyurtma bermoqchimisiz?"\n` +
    `4. Katalogda yo'q mahsulot so'ralganda: "Hozircha ${storeName}da bu mahsulot yo'q, lekin sizga [o'xshash mahsulot] tavsiya qilaman. Qiziqasizmi?"\n` +
    `5. Mijoz rus tilida yozsa — rus tilida javob bering.\n` +
    `6. Mijoz sotib olishga tayyor bo'lsa, ketma-ket so'rang: Ismi → Telefon raqami → Yetkazib berish manzili.\n` +
    `7. Uch ma'lumot to'liq olingach, javob oxirida AYNAN quyidagini yozing (boshqa hech narsa qo'shmang):\n` +
    `${ORDER_MARKER} {"name": "...", "phone": "...", "address": "...", "items": "...", "total": 0}`
  );
}

// ---------------------------------------------------------------------------
// AI message handler
// ---------------------------------------------------------------------------
async function handleAiMessage(
  botToken: string,
  chatId: number,
  fromId: number,
  userText: string,
  store: typeof storesTable.$inferSelect
): Promise<void> {
  appendHistory(botToken, chatId, "user", userText);
  const recentHistory = getHistory(botToken, chatId).slice(-8);

  const response = await openai.chat.completions.create({
    model: MODEL,
    max_tokens: 300,
    messages: [
      { role: "system", content: buildSystemPrompt(store.storeName, store.contextData) },
      ...recentHistory,
    ],
  });

  const aiText = (response.choices[0]?.message?.content ?? "").trim();
  logger.info({ chatId, aiTextLength: aiText.length }, "AI response received");

  if (!aiText) {
    await sendMessage(botToken, chatId, "Kechirasiz, qayta yuboring.");
    return;
  }

  const { reply, order } = extractOrder(aiText);

  if (order) {
    await db.insert(ordersTable).values({
      storeId: store.id,
      customerTgId: BigInt(fromId),
      customerName: order.name,
      customerPhone: order.phone,
      customerAddress: order.address,
      orderItems: { items: order.items },
      totalPrice: String(order.total ?? 0),
      status: "PENDING",
    });
    logger.info({ storeId: store.id, customer: order.name }, "Order committed to DB");
    clearHistory(botToken, chatId);

    const owner = await db.query.usersTable.findFirst({ where: eq(usersTable.id, store.ownerId) });
    if (owner) {
      const platformToken = process.env.PLATFORM_BOT_TOKEN;
      if (platformToken) {
        const notification =
          `🔔 <b>YANGI BUYURTMA!</b>\n\n` +
          `🏪 Do'kon: ${store.storeName}\n` +
          `👤 Mijoz: ${order.name}\n` +
          `📞 Tel: ${order.phone}\n` +
          `📍 Manzil: ${order.address}\n` +
          `🛒 Mahsulot: ${order.items}\n` +
          `💰 Summa: ${order.total} so'm`;
        await sendMessage(platformToken, Number(owner.telegramId), notification);
      }
    }

    const customerReply = reply || "✅ Buyurtmangiz qabul qilindi! Tez orada siz bilan bog'lanamiz. Rahmat! 🙏";
    await sendMessage(botToken, chatId, customerReply, [
      [{ text: "📦 Buyurtmalarimni ko'rish", callback_data: "menu:orders" }],
      [{ text: "🏠 Bosh menyu", callback_data: "menu:start" }],
    ]);
    appendHistory(botToken, chatId, "assistant", customerReply);
  } else {
    appendHistory(botToken, chatId, "assistant", aiText);
    await sendMessage(botToken, chatId, aiText);
  }
}

// ---------------------------------------------------------------------------
// Webhook route
// ---------------------------------------------------------------------------
router.post("/webhook/store/:bot_token", async (req, res) => {
  res.sendStatus(200);

  const { bot_token } = req.params as { bot_token: string };
  const body = req.body as Record<string, unknown>;

  try {
    const store = await db.query.storesTable.findFirst({
      where: eq(storesTable.botToken, bot_token),
    });
    if (!store || !store.isActive) return;

    // ── Callback query (inline button press) ──────────────────────────────
    const callbackQuery = body.callback_query as Record<string, unknown> | undefined;
    if (callbackQuery) {
      const cbId = callbackQuery.id as string;
      const data = callbackQuery.data as string | undefined;
      const cbChat = (callbackQuery.message as Record<string, unknown>)?.chat as Record<string, unknown> | undefined;
      const cbFrom = callbackQuery.from as Record<string, unknown> | undefined;
      const chatId = cbChat?.id as number | undefined;
      const fromId = cbFrom?.id as number | undefined;
      if (!chatId || !data) return;

      await answerCallbackQuery(bot_token, cbId);

      switch (data) {
        case "menu:start":
          await handleStart(bot_token, chatId, String(cbFrom?.first_name ?? ""), store);
          break;
        case "menu:catalog":
          await handleCatalog(bot_token, chatId, store);
          break;
        case "menu:orders":
          await handleMyOrders(bot_token, chatId, fromId ?? chatId);
          break;
        case "menu:chat":
          await sendMessage(
            bot_token, chatId,
            "💬 Qaysi mahsulot haqida ma'lumot olmoqchisiz?\n\nSavol yuboring — men javob beraman!",
            [[{ text: "🔙 Orqaga", callback_data: "menu:start" }]]
          );
          break;
        default:
          logger.warn({ data }, "Unknown callback_data");
      }
      return;
    }

    // ── Regular message ────────────────────────────────────────────────────
    const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
    if (!message) return;

    const chatId = ((message.chat as Record<string, unknown>)?.id as number) ?? 0;
    const userText = ((message.text as string | undefined) ?? "").trim();
    const fromId = ((message.from as Record<string, unknown>)?.id as number) ?? 0;
    const firstName = String((message.from as Record<string, unknown>)?.first_name ?? "");

    if (!chatId || !userText) return;

    if (userText === "/start" || userText.toLowerCase() === "salom" || userText.toLowerCase() === "привет") {
      await handleStart(bot_token, chatId, firstName, store);
      return;
    }
    if (userText === "/catalog") { await handleCatalog(bot_token, chatId, store); return; }
    if (userText === "/orders") { await handleMyOrders(bot_token, chatId, fromId); return; }

    // Everything else → AI
    await handleAiMessage(bot_token, chatId, fromId, userText, store);

  } catch (err) {
    console.error("[StoreBot] FATAL error:", err);
    logger.error({ err }, "Store webhook handler error");
    const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
    const chatId = ((message?.chat as Record<string, unknown>)?.id as number) ?? 0;
    if (chatId) {
      await sendMessage(bot_token, chatId, "Kechirasiz, hozir texnik muammo bor. Bir oz kutib qayta yozing.");
    }
  }
});

export { sendPhoto };
export default router;
