import { Router } from "express";
import { db } from "@workspace/db";
import { storesTable, ordersTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";

const router = Router();

const MODEL = "Qwen/Qwen2.5-72B-Instruct";
const ORDER_MARKER = "___CREATE_ORDER___";

// ---------------------------------------------------------------------------
// Conversation history (in-memory)
// ---------------------------------------------------------------------------
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
const conversationHistory = new Map<string, ChatMessage[]>();

function historyKey(botToken: string, chatId: number): string {
  return `${botToken}:${chatId}`;
}
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
    if (keyboard) {
      payload.reply_markup = { inline_keyboard: keyboard };
    }
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ chatId, body }, "Telegram sendMessage failed");
    }
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
    if (keyboard) {
      payload.reply_markup = { inline_keyboard: keyboard };
    }
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ chatId, body }, "Telegram sendPhoto failed");
    }
  } catch (err) {
    logger.error({ err, chatId }, "sendPhoto network error");
  }
}

async function answerCallbackQuery(botToken: string, callbackQueryId: string, text?: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (err) {
    logger.error({ err }, "answerCallbackQuery network error");
  }
}

// ---------------------------------------------------------------------------
// Main navigation keyboard
// ---------------------------------------------------------------------------
const MAIN_KEYBOARD: InlineKeyboard = [
  [
    { text: "🛍 Katalog", callback_data: "menu:catalog" },
    { text: "📦 Buyurtmalarim", callback_data: "menu:orders" },
  ],
  [{ text: "💬 AI Maslahatchi", callback_data: "menu:chat" }],
];

// ---------------------------------------------------------------------------
// /start handler
// ---------------------------------------------------------------------------
async function handleStart(botToken: string, chatId: number, firstName: string, store: typeof storesTable.$inferSelect): Promise<void> {
  const welcome =
    `👋 Assalomu alaykum, <b>${firstName}</b>!\n\n` +
    `<b>${store.storeName}</b> do'koniga xush kelibsiz! 🎉\n\n` +
    `Men sizning AI-maslahatchi robotingizman. Mahsulotlar haqida savol bering yoki quyidagi tugmalardan birini tanlang:`;

  await sendMessage(botToken, chatId, welcome, MAIN_KEYBOARD);
}

// ---------------------------------------------------------------------------
// Catalog handler — formats contextData as a product card
// ---------------------------------------------------------------------------
async function handleCatalog(botToken: string, chatId: number, store: typeof storesTable.$inferSelect): Promise<void> {
  const catalogText =
    `🛍 <b>${store.storeName} — Katalog</b>\n\n` +
    `${store.contextData}\n\n` +
    `💬 Biror mahsulot haqida batafsil ma'lumot olish uchun yozing yoki pastdagi tugmani bosing:`;

  const keyboard: InlineKeyboard = [
    [{ text: "💬 AI bilan suhbat boshlash", callback_data: "menu:chat" }],
    [{ text: "🔙 Orqaga", callback_data: "menu:start" }],
  ];

  await sendMessage(botToken, chatId, catalogText, keyboard);
}

// ---------------------------------------------------------------------------
// My Orders handler — queries real orders from DB
// ---------------------------------------------------------------------------
async function handleMyOrders(botToken: string, chatId: number, fromId: number): Promise<void> {
  const orders = await db.query.ordersTable.findMany({
    where: eq(ordersTable.customerTgId, BigInt(fromId)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 5,
  });

  const keyboard: InlineKeyboard = [[{ text: "🔙 Orqaga", callback_data: "menu:start" }]];

  if (!orders.length) {
    await sendMessage(
      botToken,
      chatId,
      "📦 Sizda hali buyurtmalar yo'q.\n\nBiror mahsulot haqida so'rash uchun <b>AI Maslahatchi</b>ga murojaat qiling!",
      keyboard
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
    const status = statusEmoji[o.status] ?? o.status;
    const date = new Date(o.createdAt).toLocaleDateString("uz-UZ");
    return `${i + 1}. <b>${o.orderItems && typeof o.orderItems === "object" && "items" in o.orderItems ? String((o.orderItems as Record<string,unknown>).items) : "Mahsulot"}</b>\n   💰 ${o.totalPrice} so'm  |  ${status}  |  📅 ${date}`;
  });

  const text = `📦 <b>Oxirgi buyurtmalaringiz:</b>\n\n${lines.join("\n\n")}`;
  await sendMessage(botToken, chatId, text, keyboard);
}

// ---------------------------------------------------------------------------
// Order extraction helpers
// ---------------------------------------------------------------------------
interface OrderData {
  name: string;
  phone: string;
  address: string;
  items: string;
  total: number;
}

function extractOrder(aiText: string): { reply: string; order: OrderData | null } {
  const idx = aiText.indexOf(ORDER_MARKER);
  if (idx === -1) return { reply: aiText.trim(), order: null };

  const reply = aiText.slice(0, idx).trim();
  const after = aiText.slice(idx + ORDER_MARKER.length).trim();
  const match = after.match(/\{[\s\S]*?\}/);
  if (!match) {
    logger.warn({ after }, "ORDER_MARKER found but no JSON");
    return { reply, order: null };
  }
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

function buildSystemPrompt(storeName: string, catalog: string): string {
  return (
    `Siz "${storeName}" do'koni uchun xushmuomala AI-sotuvchisiz. ` +
    `Faqat quyidagi katalog bo'yicha javob bering:\n${catalog}\n\n` +
    `Qoidalar:\n` +
    `- Javoblar qisqa va aniq bo'lsin (2-3 jumla max).\n` +
    `- Faqat bir marta salomlashing. Keyingi xabarlarda salomlashmang.\n` +
    `- Mijoz rus tilida yozsa — rus tilida javob bering.\n` +
    `- Mijoz sotib olishga tayyor bo'lsa, ketma-ket so'rang: Ismi → Telefoni → Manzili.\n` +
    `- Barcha uch ma'lumot olingach, darhol javob oxirida quyidagini yozing (boshqa hech narsa qo'shmang):\n` +
    `${ORDER_MARKER} {"name": "...", "phone": "...", "address": "...", "items": "...", "total": 0}`
  );
}

// ---------------------------------------------------------------------------
// AI chat handler (existing logic, unchanged)
// ---------------------------------------------------------------------------
async function handleAiMessage(
  botToken: string,
  chatId: number,
  fromId: number,
  userText: string,
  store: typeof storesTable.$inferSelect
): Promise<void> {
  appendHistory(botToken, chatId, "user", userText);
  const recentHistory = getHistory(botToken, chatId).slice(-6);

  const response = await openai.chat.completions.create({
    model: MODEL,
    max_tokens: 256,
    messages: [
      { role: "system", content: buildSystemPrompt(store.storeName, store.contextData) },
      ...recentHistory,
    ],
  });

  const aiText = (response.choices[0]?.message?.content ?? "").trim();
  logger.info({ chatId, aiTextLength: aiText.length }, "AI response received");

  if (!aiText) {
    logger.warn({ chatId }, "Empty AI response");
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
          `🔔 YANGI BUYURTMA!\n\n` +
          `🏪 Do'kon: ${store.storeName}\n` +
          `👤 Mijoz: ${order.name}\n` +
          `📞 Tel: ${order.phone}\n` +
          `📍 Manzil: ${order.address}\n` +
          `🛒 Mahsulotlar: ${order.items}\n` +
          `💰 Summa: ${order.total} so'm`;
        await sendMessage(platformToken, Number(owner.telegramId), notification);
      }
    }

    const customerReply = reply || "✅ Buyurtmangiz qabul qilindi! Tez orada siz bilan bog'lanamiz. Rahmat! 🙏";
    const postOrderKeyboard: InlineKeyboard = [
      [{ text: "📦 Buyurtmalarimni ko'rish", callback_data: "menu:orders" }],
      [{ text: "🏠 Bosh menyu", callback_data: "menu:start" }],
    ];
    await sendMessage(botToken, chatId, customerReply, postOrderKeyboard);
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
    // ── Resolve store ───────────────────────────────────────────────────────
    const store = await db.query.storesTable.findFirst({
      where: eq(storesTable.botToken, bot_token),
    });
    if (!store || !store.isActive) return;

    // ── Callback query (inline button press) ───────────────────────────────
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
          await handleStart(bot_token, chatId, String(cbFrom?.first_name ?? "Foydalanuvchi"), store);
          break;
        case "menu:catalog":
          await handleCatalog(bot_token, chatId, store);
          break;
        case "menu:orders":
          await handleMyOrders(bot_token, chatId, fromId ?? chatId);
          break;
        case "menu:chat":
          await sendMessage(
            bot_token,
            chatId,
            "💬 Menga mahsulot haqida istalgan savolingizni yuboring — men javob beraman!",
            [[{ text: "🔙 Orqaga", callback_data: "menu:start" }]]
          );
          break;
        default:
          logger.warn({ data }, "Unknown callback_data");
      }
      return;
    }

    // ── Regular message ─────────────────────────────────────────────────────
    const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
    if (!message) return;

    const chatId = ((message.chat as Record<string, unknown>)?.id as number) ?? 0;
    const userText = ((message.text as string | undefined) ?? "").trim();
    const fromId = ((message.from as Record<string, unknown>)?.id as number) ?? 0;
    const firstName = String((message.from as Record<string, unknown>)?.first_name ?? "Foydalanuvchi");

    if (!chatId || !userText) return;

    // /start command
    if (userText === "/start") {
      await handleStart(bot_token, chatId, firstName, store);
      return;
    }

    // /catalog command
    if (userText === "/catalog") {
      await handleCatalog(bot_token, chatId, store);
      return;
    }

    // /orders command
    if (userText === "/orders") {
      await handleMyOrders(bot_token, chatId, fromId);
      return;
    }

    // All other text → AI
    await handleAiMessage(bot_token, chatId, fromId, userText, store);

  } catch (err) {
    console.error("[StoreBot] FATAL error in webhook handler:", err);
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
