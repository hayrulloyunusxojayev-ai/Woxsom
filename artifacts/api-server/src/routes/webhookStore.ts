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

const MODEL = "Qwen/Qwen2.5-72B-Instruct";
const ORDER_MARKER = "___CREATE_ORDER___";
const AI_TIMEOUT_MS = 25_000;

// ---------------------------------------------------------------------------
// Navigation — only 2 buttons
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
  botToken: string,
  chatId: number,
  firstName: string,
  storeName: string,
): Promise<void> {
  await tgSend(
    botToken,
    chatId,
    `👋 Salom, <b>${firstName}</b>!\n\n` +
      `<b>${storeName}</b> do'koniga xush kelibsiz.\n` +
      `Mahsulotlar haqida savol bering yoki bo'limni tanlang:`,
    MAIN_KEYBOARD,
  );
}

// ---------------------------------------------------------------------------
// Catalog — formatted cards, no raw text dump
// ---------------------------------------------------------------------------
async function handleCatalog(
  botToken: string,
  chatId: number,
  contextData: string,
  storeName: string,
): Promise<void> {
  const lines = contextData.split("\n").map((l) => l.trim()).filter(Boolean);
  const products = lines
    .map((l) => {
      const parts = l.split("|").map((p) => p.trim());
      return parts.length >= 2 ? { name: parts[0], price: parts[1] } : null;
    })
    .filter(Boolean) as { name: string; price: string }[];

  if (!products.length) {
    await tgSend(botToken, chatId, "Katalog hozir mavjud emas.", MAIN_KEYBOARD);
    return;
  }

  const list = products
    .map((p, i) => `${i + 1}. <b>${p.name}</b> — ${p.price}`)
    .join("\n");

  await tgSend(
    botToken,
    chatId,
    `🛍 <b>${storeName}</b>\n\n${list}\n\n` +
      `💬 Biror mahsulot haqida batafsil so'rang — nomini yuboring.`,
    [[{ text: "🔙 Orqaga", callback_data: "menu:start" }]],
  );
}

// ---------------------------------------------------------------------------
// My Orders (last 5 for this customer)
// ---------------------------------------------------------------------------
async function handleMyOrders(
  botToken: string,
  chatId: number,
  fromId: number,
): Promise<void> {
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

  const statusEmoji: Record<string, string> = {
    PENDING: "🕐 Kutilmoqda",
    PAID: "✅ To'langan",
    SHIPPED: "🚚 Yetkazilmoqda",
    DELIVERED: "📬 Yetkazildi",
    CANCELLED: "❌ Bekor qilindi",
  };

  const lines = orders.map((o, i) => {
    const items =
      typeof o.orderItems === "object" &&
      o.orderItems !== null &&
      "items" in o.orderItems
        ? String((o.orderItems as Record<string, unknown>).items)
        : "Mahsulot";
    const date = new Date(o.createdAt).toLocaleDateString("uz-UZ");
    return (
      `${i + 1}. <b>${items}</b>\n` +
      `   💰 ${o.totalPrice} so'm  |  ${statusEmoji[o.status] ?? o.status}  |  📅 ${date}`
    );
  });

  await tgSend(
    botToken,
    chatId,
    `📦 <b>Oxirgi buyurtmalaringiz:</b>\n\n${lines.join("\n\n")}`,
    backBtn,
  );
}

// ---------------------------------------------------------------------------
// Order extraction
// ---------------------------------------------------------------------------
interface OrderData {
  name: string;
  phone: string;
  address: string;
  items: string;
  total: number;
}

function extractOrder(
  aiText: string,
): { reply: string; order: OrderData | null } {
  const idx = aiText.indexOf(ORDER_MARKER);
  if (idx === -1) return { reply: aiText.trim(), order: null };
  const reply = aiText.slice(0, idx).trim();
  const match = aiText.slice(idx + ORDER_MARKER.length).trim().match(/\{[\s\S]*?\}/);
  if (!match) return { reply, order: null };
  try {
    const order = JSON.parse(match[0]) as OrderData;
    if (!order.name || !order.phone || !order.address) return { reply, order: null };
    return { reply, order };
  } catch {
    return { reply, order: null };
  }
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
// AI handler — with per-chat lock + timeout
// ---------------------------------------------------------------------------
async function handleAiMessage(
  botToken: string,
  chatId: number,
  fromId: number,
  userText: string,
  storeId: string,
  storeOwnerId: string,
  storeName: string,
  contextData: string,
): Promise<void> {
  // One AI request at a time per chat — drop if one is already in flight
  if (!tryLockChat(botToken, chatId)) {
    await tgSend(
      botToken,
      chatId,
      "⏳ Avvalgi xabaringiz hali ishlanmoqda. Biroz kuting...",
    );
    return;
  }

  try {
    appendHistory(botToken, chatId, "user", userText);
    const recentHistory = getHistory(botToken, chatId).slice(-8);

    // Abort AI call if it takes longer than AI_TIMEOUT_MS
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    let aiText: string;
    try {
      const response = await openai.chat.completions.create(
        {
          model: MODEL,
          max_tokens: 300,
          messages: [
            {
              role: "system",
              content: buildSystemPrompt(storeName, contextData),
            },
            ...recentHistory,
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

      // Notify store owner via platform bot
      const owner = await db.query.usersTable.findFirst({
        where: eq(usersTable.id, storeOwnerId),
      });
      const platformToken = process.env.PLATFORM_BOT_TOKEN;
      if (owner && platformToken) {
        // Fire-and-forget — don't await so it doesn't block the customer reply
        tgSend(
          platformToken,
          Number(owner.telegramId),
          `🔔 <b>YANGI BUYURTMA!</b>\n\n🏪 ${storeName}\n👤 ${order.name}\n📞 ${order.phone}\n📍 ${order.address}\n🛒 ${order.items}\n💰 ${order.total} so'm`,
        ).catch((e) => logger.error({ e }, "Owner notification failed"));
      }

      const customerReply =
        reply || "✅ Buyurtmangiz qabul qilindi! Tez orada bog'lanamiz. Rahmat! 🙏";
      await tgSend(botToken, chatId, customerReply, [
        [{ text: "📦 Buyurtmalarimni ko'rish", callback_data: "menu:orders" }],
        [{ text: "🏠 Bosh menyu", callback_data: "menu:start" }],
      ]);
      appendHistory(botToken, chatId, "assistant", customerReply);
    } else {
      appendHistory(botToken, chatId, "assistant", aiText);
      await tgSend(botToken, chatId, aiText);
    }
  } finally {
    unlockChat(botToken, chatId);
  }
}

// ---------------------------------------------------------------------------
// Webhook route
// ---------------------------------------------------------------------------
router.post("/webhook/store/:bot_token", async (req, res) => {
  // Respond to Telegram immediately — processing is async
  res.sendStatus(200);

  const { bot_token } = req.params as { bot_token: string };
  const body = req.body as Record<string, unknown>;

  try {
    // Cache-first store lookup — avoids a DB query on every message
    const store = await getStoreByToken(bot_token);
    if (!store || !store.isActive) return;

    // ── Callback query (inline button press) ──────────────────────────────
    const cbq = body.callback_query as Record<string, unknown> | undefined;
    if (cbq) {
      const cbId = cbq.id as string;
      const data = (cbq.data as string | undefined) ?? "";
      const cbChat = (cbq.message as Record<string, unknown>)?.chat as
        | Record<string, unknown>
        | undefined;
      const cbFrom = cbq.from as Record<string, unknown> | undefined;
      const chatId = cbChat?.id as number | undefined;
      const fromId = cbFrom?.id as number | undefined;
      if (!chatId || !data) return;

      await tgAnswer(bot_token, cbId);

      if (data === "menu:start") {
        await handleStart(
          bot_token,
          chatId,
          String(cbFrom?.first_name ?? ""),
          store.storeName,
        );
      } else if (data === "menu:catalog") {
        await handleCatalog(bot_token, chatId, store.contextData, store.storeName);
      } else if (data === "menu:orders") {
        await handleMyOrders(bot_token, chatId, fromId ?? chatId);
      }
      return;
    }

    // ── Regular message ────────────────────────────────────────────────────
    const message = (body.message ?? body.edited_message) as
      | Record<string, unknown>
      | undefined;
    if (!message) return;

    const chatId = ((message.chat as Record<string, unknown>)?.id as number) ?? 0;
    const userText = ((message.text as string | undefined) ?? "").trim();
    const fromId =
      ((message.from as Record<string, unknown>)?.id as number) ?? 0;
    const firstName = String(
      (message.from as Record<string, unknown>)?.first_name ?? "",
    );
    if (!chatId || !userText) return;

    const lower = userText.toLowerCase();
    if (
      userText === "/start" ||
      lower === "salom" ||
      lower === "привет" ||
      lower === "start"
    ) {
      await handleStart(bot_token, chatId, firstName, store.storeName);
      return;
    }
    if (userText === "/catalog") {
      await handleCatalog(bot_token, chatId, store.contextData, store.storeName);
      return;
    }
    if (userText === "/orders") {
      await handleMyOrders(bot_token, chatId, fromId);
      return;
    }

    await handleAiMessage(
      bot_token,
      chatId,
      fromId,
      userText,
      store.id,
      store.ownerId,
      store.storeName,
      store.contextData,
    );
  } catch (err) {
    logger.error({ err }, "Store webhook fatal error");
    // Best-effort error reply — don't let this crash the handler
    try {
      const msg = (body.message ?? body.edited_message) as
        | Record<string, unknown>
        | undefined;
      const chatId =
        ((msg?.chat as Record<string, unknown>)?.id as number) ?? 0;
      if (chatId) {
        await tgSend(
          bot_token,
          chatId,
          "Kechirasiz, texnik muammo. Qayta urinib ko'ring.",
        );
      }
    } catch { /* ignore secondary error */ }
  }
});

export { tgSendPhoto };
export default router;
