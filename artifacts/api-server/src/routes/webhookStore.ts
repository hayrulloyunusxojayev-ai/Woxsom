import { Router } from "express";
import { db } from "@workspace/db";
import { storesTable, ordersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";

const router = Router();

const ORDER_MARKER = "___CREATE_ORDER___";

// In-memory conversation history: key = "botToken:chatId"
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

async function sendTelegramMessage(botToken: string, chatId: number | bigint, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), text: text.slice(0, 4096) }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ chatId, body }, "Telegram sendMessage failed");
    }
  } catch (err) {
    logger.error({ err, chatId }, "sendTelegramMessage network error");
  }
}

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

router.post("/webhook/store/:bot_token", async (req, res) => {
  res.sendStatus(200);

  const { bot_token } = req.params as { bot_token: string };
  const body = req.body as Record<string, unknown>;
  const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
  if (!message) return;

  const chatId = ((message.chat as Record<string, unknown>)?.id as number) ?? 0;
  const userText = ((message.text as string | undefined) ?? "").trim();
  const fromId = ((message.from as Record<string, unknown>)?.id as number) ?? 0;

  if (!chatId || !userText) return;

  try {
    const store = await db.query.storesTable.findFirst({
      where: eq(storesTable.botToken, bot_token),
    });
    if (!store || !store.isActive) return;

    appendHistory(bot_token, chatId, "user", userText);
    // Keep only the last 6 messages (3 turns) for a tiny, fast payload
    const recentHistory = getHistory(bot_token, chatId).slice(-6);

    const response = await openai.chat.completions.create({
      model: "Qwen/Qwen2.5-72B-Instruct",
      max_tokens: 256,
      messages: [
        { role: "system", content: buildSystemPrompt(store.storeName, store.contextData) },
        ...recentHistory,
      ],
    });

    const aiText = (response.choices[0]?.message?.content ?? "").trim();
    logger.info({ chatId, aiTextLength: aiText.length }, "AI response received");

    if (!aiText) {
      logger.warn({ chatId, response }, "Empty AI response");
      await sendTelegramMessage(bot_token, chatId, "Kechirasiz, qayta yuboring.");
      return;
    }

    const { reply, order } = extractOrder(aiText);

    if (order) {
      // 1. Commit to DB first
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

      // 2. Clear history for this customer
      clearHistory(bot_token, chatId);

      // 3. Notify store owner via platform bot
      const owner = await db.query.usersTable.findFirst({
        where: eq(usersTable.id, store.ownerId),
      });
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
          await sendTelegramMessage(platformToken, owner.telegramId, notification);
        }
      }

      // 4. Reply to customer
      const customerReply = reply || "✅ Buyurtmangiz qabul qilindi! Tez orada siz bilan bog'lanamiz. Rahmat! 🙏";
      await sendTelegramMessage(bot_token, chatId, customerReply);
      appendHistory(bot_token, chatId, "assistant", customerReply);
    } else {
      appendHistory(bot_token, chatId, "assistant", aiText);
      await sendTelegramMessage(bot_token, chatId, aiText);
    }
  } catch (err) {
    // Use console.error so it always appears in logs even if pino drops it
    console.error("[StoreBot] FATAL error in webhook handler:", err);
    logger.error({ err }, "Store webhook handler error");
    await sendTelegramMessage(
      bot_token,
      chatId,
      "Kechirasiz, hozir texnik muammo bor. Bir oz kutib qayta yozing."
    );
  }
});

export default router;
