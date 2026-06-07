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
// Conversation history
// ---------------------------------------------------------------------------
interface ChatMessage { role: "user" | "assistant"; content: string; }
const conversationHistory = new Map<string, ChatMessage[]>();

function historyKey(t: string, c: number) { return `${t}:${c}`; }
function getHistory(t: string, c: number): ChatMessage[] {
  const k = historyKey(t, c);
  if (!conversationHistory.has(k)) conversationHistory.set(k, []);
  return conversationHistory.get(k)!;
}
function appendHistory(t: string, c: number, role: "user" | "assistant", content: string) {
  getHistory(t, c).push({ role, content });
}
function clearHistory(t: string, c: number) { conversationHistory.delete(historyKey(t, c)); }

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------
type InlineKeyboard = { text: string; callback_data: string }[][];

async function sendMessage(
  botToken: string, chatId: number | bigint, text: string, keyboard?: InlineKeyboard
): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: Number(chatId), text: text.slice(0, 4096), parse_mode: "HTML",
    };
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!res.ok) logger.warn({ chatId, body: await res.text() }, "sendMessage failed");
  } catch (err) { logger.error({ err, chatId }, "sendMessage error"); }
}

export async function sendPhoto(
  botToken: string, chatId: number | bigint, photoUrl: string, caption: string, keyboard?: InlineKeyboard
): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: Number(chatId), photo: photoUrl, caption: caption.slice(0, 1024), parse_mode: "HTML",
    };
    if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!res.ok) logger.warn({ chatId, body: await res.text() }, "sendPhoto failed");
  } catch (err) { logger.error({ err, chatId }, "sendPhoto error"); }
}

async function answerCallbackQuery(botToken: string, id: string, text?: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text }),
    });
  } catch (err) { logger.error({ err }, "answerCallbackQuery error"); }
}

// ---------------------------------------------------------------------------
// Navigation — only 2 buttons, no AI button
// ---------------------------------------------------------------------------
const MAIN_KEYBOARD: InlineKeyboard = [
  [
    { text: "🛍 Katalog", callback_data: "menu:catalog" },
    { text: "📦 Buyurtmalarim", callback_data: "menu:orders" },
  ],
];

// ---------------------------------------------------------------------------
// Welcome screen
// ---------------------------------------------------------------------------
async function handleStart(
  botToken: string, chatId: number, firstName: string, store: typeof storesTable.$inferSelect
): Promise<void> {
  await sendMessage(
    botToken, chatId,
    `👋 Salom, <b>${firstName}</b>!\n\n` +
    `<b>${store.storeName}</b> do'koniga xush kelibsiz.\n` +
    `Mahsulotlar haqida savol bering yoki bo'limni tanlang:`,
    MAIN_KEYBOARD
  );
}

// ---------------------------------------------------------------------------
// Catalog — product cards, no raw text dump
// ---------------------------------------------------------------------------
async function handleCatalog(
  botToken: string, chatId: number, store: typeof storesTable.$inferSelect
): Promise<void> {
  const lines = store.contextData.split("\n").map(l => l.trim()).filter(Boolean);
  const products = lines.map(l => {
    const parts = l.split("|").map(p => p.trim());
    return parts.length >= 2 ? { name: parts[0], price: parts[1] } : null;
  }).filter(Boolean) as { name: string; price: string }[];

  if (!products.length) {
    await sendMessage(botToken, chatId, "Katalog hozir mavjud emas.", MAIN_KEYBOARD);
    return;
  }

  const productList = products.map((p, i) => `${i + 1}. <b>${p.name}</b> — ${p.price}`).join("\n");
  await sendMessage(
    botToken, chatId,
    `🛍 <b>${store.storeName}</b>\n\n${productList}\n\n` +
    `💬 Biror mahsulot haqida batafsil so'rang — nomini yuboring.`,
    [[{ text: "🔙 Orqaga", callback_data: "menu:start" }]]
  );
}

// ---------------------------------------------------------------------------
// My Orders
// ---------------------------------------------------------------------------
async function handleMyOrders(botToken: string, chatId: number, fromId: number): Promise<void> {
  const orders = await db.query.ordersTable.findMany({
    where: eq(ordersTable.customerTgId, BigInt(fromId)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 5,
  });

  const backBtn: InlineKeyboard = [[{ text: "🔙 Orqaga", callback_data: "menu:start" }]];

  if (!orders.length) {
    await sendMessage(botToken, chatId, "📦 Sizda hali buyurtmalar yo'q.", backBtn);
    return;
  }

  const statusEmoji: Record<string, string> = {
    PENDING: "🕐 Kutilmoqda", PAID: "✅ To'langan",
    SHIPPED: "🚚 Yetkazilmoqda", DELIVERED: "📬 Yetkazildi", CANCELLED: "❌ Bekor qilindi",
  };

  const lines = orders.map((o, i) => {
    const items = typeof o.orderItems === "object" && o.orderItems !== null && "items" in o.orderItems
      ? String((o.orderItems as Record<string, unknown>).items) : "Mahsulot";
    const date = new Date(o.createdAt).toLocaleDateString("uz-UZ");
    return `${i + 1}. <b>${items}</b>\n   💰 ${o.totalPrice} so'm  |  ${statusEmoji[o.status] ?? o.status}  |  📅 ${date}`;
  });

  await sendMessage(
    botToken, chatId,
    `📦 <b>Oxirgi buyurtmalaringiz:</b>\n\n${lines.join("\n\n")}`,
    backBtn
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
  const match = aiText.slice(idx + ORDER_MARKER.length).trim().match(/\{[\s\S]*?\}/);
  if (!match) return { reply, order: null };
  try {
    const order = JSON.parse(match[0]) as OrderData;
    if (!order.name || !order.phone || !order.address) return { reply, order: null };
    return { reply, order };
  } catch { return { reply, order: null }; }
}

// ---------------------------------------------------------------------------
// System prompt — Premium Sales Consultant
// ---------------------------------------------------------------------------
function buildSystemPrompt(storeName: string, catalog: string): string {
  return (
    `Siz "${storeName}" do'konining premium savdo maslahatchidasiz. Qisqa, aniq, xushmuomala bo'ling.\n\n` +
    `MAHSULOTLAR (bilim bazasi — to'liq ro'yxatni yubormang):\n${catalog}\n\n` +
    `QOIDALAR:\n` +
    `1. Birinchi xabarda bir marta salomlashing, keyingilarida salomlashmang.\n` +
    `2. Mahsulot so'ralganda: Nomi, Narxi, 1-2 xususiyat — 2-3 jumla.\n` +
    `3. Har bir tavsifdan keyin so'rang: "Buyurtma bermoqchimisiz?"\n` +
    `4. Yo'q mahsulot: "Hozircha ${storeName}da bu yo'q, lekin [o'xshash mahsulot] bor. Qiziqasizmi?"\n` +
    `5. Mijoz rus tilida yozsa — rus tilida javob bering.\n` +
    `6. Buyurtma uchun ketma-ket so'rang: Ismi → Telefon → Manzil.\n` +
    `7. Uch ma'lumot olingach javob oxirida yozing:\n` +
    `${ORDER_MARKER} {"name":"...","phone":"...","address":"...","items":"...","total":0}`
  );
}

// ---------------------------------------------------------------------------
// AI handler
// ---------------------------------------------------------------------------
async function handleAiMessage(
  botToken: string, chatId: number, fromId: number,
  userText: string, store: typeof storesTable.$inferSelect
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
  if (!aiText) { await sendMessage(botToken, chatId, "Kechirasiz, qayta yuboring."); return; }

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
    logger.info({ storeId: store.id, customer: order.name }, "Order committed");
    clearHistory(botToken, chatId);

    const owner = await db.query.usersTable.findFirst({ where: eq(usersTable.id, store.ownerId) });
    if (owner && process.env.PLATFORM_BOT_TOKEN) {
      await sendMessage(
        process.env.PLATFORM_BOT_TOKEN, Number(owner.telegramId),
        `🔔 <b>YANGI BUYURTMA!</b>\n\n🏪 ${store.storeName}\n👤 ${order.name}\n📞 ${order.phone}\n📍 ${order.address}\n🛒 ${order.items}\n💰 ${order.total} so'm`
      );
    }

    const customerReply = reply || "✅ Buyurtmangiz qabul qilindi! Tez orada bog'lanamiz. Rahmat! 🙏";
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
    const store = await db.query.storesTable.findFirst({ where: eq(storesTable.botToken, bot_token) });
    if (!store || !store.isActive) return;

    // Callback query (inline button press)
    const cbq = body.callback_query as Record<string, unknown> | undefined;
    if (cbq) {
      const cbId = cbq.id as string;
      const data = cbq.data as string | undefined;
      const cbChat = (cbq.message as Record<string, unknown>)?.chat as Record<string, unknown> | undefined;
      const cbFrom = cbq.from as Record<string, unknown> | undefined;
      const chatId = cbChat?.id as number | undefined;
      const fromId = cbFrom?.id as number | undefined;
      if (!chatId || !data) return;
      await answerCallbackQuery(bot_token, cbId);

      if (data === "menu:start") {
        await handleStart(bot_token, chatId, String(cbFrom?.first_name ?? ""), store);
      } else if (data === "menu:catalog") {
        await handleCatalog(bot_token, chatId, store);
      } else if (data === "menu:orders") {
        await handleMyOrders(bot_token, chatId, fromId ?? chatId);
      }
      return;
    }

    // Regular message
    const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
    if (!message) return;
    const chatId = ((message.chat as Record<string, unknown>)?.id as number) ?? 0;
    const userText = ((message.text as string | undefined) ?? "").trim();
    const fromId = ((message.from as Record<string, unknown>)?.id as number) ?? 0;
    const firstName = String((message.from as Record<string, unknown>)?.first_name ?? "");
    if (!chatId || !userText) return;

    const lower = userText.toLowerCase();
    if (userText === "/start" || lower === "salom" || lower === "привет" || lower === "start") {
      await handleStart(bot_token, chatId, firstName, store); return;
    }
    if (userText === "/catalog") { await handleCatalog(bot_token, chatId, store); return; }
    if (userText === "/orders") { await handleMyOrders(bot_token, chatId, fromId); return; }

    await handleAiMessage(bot_token, chatId, fromId, userText, store);

  } catch (err) {
    console.error("[StoreBot] FATAL:", err);
    logger.error({ err }, "Store webhook error");
    const msg = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
    const chatId = ((msg?.chat as Record<string, unknown>)?.id as number) ?? 0;
    if (chatId) await sendMessage(bot_token, chatId, "Kechirasiz, texnik muammo. Qayta urinib ko'ring.");
  }
});

export default router;
