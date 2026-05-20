import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { storesTable, ordersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";

const router = Router();

const ORDER_MARKER = "___CREATE_ORDER___";
const GRAPH_API_URL = "https://graph.facebook.com/v25.0/me/messages";

// Separate in-memory history for Instagram conversations
// Key format: "instagram:{senderId}" — never collides with Telegram keys
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
const igHistory = new Map<string, ChatMessage[]>();

function igKey(senderId: string): string {
  return `instagram:${senderId}`;
}

function getIgHistory(senderId: string): ChatMessage[] {
  const key = igKey(senderId);
  if (!igHistory.has(key)) igHistory.set(key, []);
  return igHistory.get(key)!;
}

function appendIgHistory(senderId: string, role: "user" | "assistant", content: string): void {
  getIgHistory(senderId).push({ role, content });
}

function clearIgHistory(senderId: string): void {
  igHistory.delete(igKey(senderId));
}

async function sendInstagramMessage(recipientId: string, text: string): Promise<void> {
  const token = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  if (!token) {
    logger.error("INSTAGRAM_PAGE_ACCESS_TOKEN is not set");
    return;
  }
  try {
    const res = await fetch(`${GRAPH_API_URL}?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: text.slice(0, 2000) },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ recipientId, body }, "Instagram sendMessage failed");
    }
  } catch (err) {
    logger.error({ err, recipientId }, "Instagram sendMessage network error");
  }
}

async function sendTelegramMessage(botToken: string, chatId: bigint, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), text: text.slice(0, 4096) }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ chatId: chatId.toString(), body }, "Telegram sendMessage failed");
    }
  } catch (err) {
    logger.error({ err }, "Telegram sendMessage network error");
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
    logger.warn({ after }, "Instagram: ORDER_MARKER found but no JSON");
    return { reply, order: null };
  }
  try {
    const order = JSON.parse(match[0]) as OrderData;
    if (!order.name || !order.phone || !order.address) {
      logger.warn({ order }, "Instagram: Order JSON missing required fields");
      return { reply, order: null };
    }
    return { reply, order };
  } catch {
    logger.warn({ raw: match[0] }, "Instagram: Failed to parse order JSON");
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

// Resolve which store to use for Instagram messages.
// Priority: INSTAGRAM_STORE_BOT_TOKEN env var → first active store.
async function resolveStore() {
  const token = process.env.INSTAGRAM_STORE_BOT_TOKEN;
  if (token) {
    return db.query.storesTable.findFirst({ where: eq(storesTable.botToken, token) });
  }
  return db.query.storesTable.findFirst({ where: eq(storesTable.isActive, true) });
}

// GET /api/webhook/instagram — Meta verification challenge
router.get("/webhook/instagram", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"] as string | undefined;
  const token = req.query["hub.verify_token"] as string | undefined;
  const challenge = req.query["hub.challenge"] as string | undefined;

  if (mode === "subscribe" && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    logger.info("Instagram webhook verification successful");
    res.status(200).send(challenge);
  } else {
    logger.warn({ mode, token }, "Instagram webhook verification failed");
    res.sendStatus(403);
  }
});

// POST /api/webhook/instagram — incoming DM events
router.post("/webhook/instagram", async (req: Request, res: Response) => {
  // Acknowledge immediately so Meta doesn't retry
  res.sendStatus(200);

  const body = req.body as Record<string, unknown>;

  // Validate it's an Instagram messaging event
  if (body.object !== "instagram") return;

  const entries = body.entry as Array<Record<string, unknown>> | undefined;
  if (!entries?.length) return;

  for (const entry of entries) {
    const messaging = entry.messaging as Array<Record<string, unknown>> | undefined;
    if (!messaging?.length) continue;

    for (const event of messaging) {
      const sender = (event.sender as Record<string, unknown> | undefined)?.id as string | undefined;
      const messageObj = event.message as Record<string, unknown> | undefined;
      const userText = (messageObj?.text as string | undefined)?.trim();

      if (!sender || !userText) continue;
      // Ignore echo messages sent by the page itself
      if (messageObj?.is_echo) continue;

      // Fire-and-forget so we don't block the loop
      handleInstagramMessage(sender, userText).catch((err) => {
        console.error("[InstagramBot] Unhandled error:", err);
      });
    }
  }
});

async function handleInstagramMessage(senderId: string, userText: string): Promise<void> {
  try {
    const store = await resolveStore();
    if (!store || !store.isActive) {
      logger.warn({ senderId }, "No active store found for Instagram message");
      return;
    }

    appendIgHistory(senderId, "user", userText);
    const recentHistory = getIgHistory(senderId).slice(-6);

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 256,
      messages: [
        { role: "system", content: buildSystemPrompt(store.storeName, store.contextData) },
        ...recentHistory,
      ],
    });

    const aiText = (response.choices[0]?.message?.content ?? "").trim();
    logger.info({ senderId, aiTextLength: aiText.length }, "Instagram AI response received");

    if (!aiText) {
      logger.warn({ senderId, response }, "Empty AI response for Instagram message");
      await sendInstagramMessage(senderId, "Kechirasiz, qayta yuboring.");
      return;
    }

    const { reply, order } = extractOrder(aiText);

    if (order) {
      // 1. Convert Instagram PSID (numeric string) to BigInt for the DB field
      const senderBigInt = BigInt(senderId);

      // 2. Commit order to DB with source='INSTAGRAM'
      await db.insert(ordersTable).values({
        storeId: store.id,
        customerTgId: senderBigInt,
        customerName: order.name,
        customerPhone: order.phone,
        customerAddress: order.address,
        orderItems: { items: order.items, source: "INSTAGRAM" },
        totalPrice: String(order.total ?? 0),
        status: "PENDING",
        source: "INSTAGRAM",
      });
      logger.info({ storeId: store.id, customer: order.name }, "Instagram order committed to DB");

      // 3. Clear conversation history for this sender
      clearIgHistory(senderId);

      // 4. Notify store owner via Telegram platform bot
      const owner = await db.query.usersTable.findFirst({
        where: eq(usersTable.id, store.ownerId),
      });
      if (owner) {
        const platformToken = process.env.PLATFORM_BOT_TOKEN;
        if (platformToken) {
          const notification =
            `🔔 YANGI INSTAGRAM BUYURTMA!\n\n` +
            `📸 Kanal: Instagram Direct\n` +
            `🏪 Do'kon: ${store.storeName}\n` +
            `👤 Mijoz: ${order.name}\n` +
            `📞 Tel: ${order.phone}\n` +
            `📍 Manzil: ${order.address}\n` +
            `🛒 Mahsulotlar: ${order.items}\n` +
            `💰 Summa: ${order.total} so'm`;
          await sendTelegramMessage(platformToken, owner.telegramId, notification);
        }
      }

      // 5. Reply to customer on Instagram (clean reply, no JSON block)
      const customerReply = reply || "✅ Buyurtmangiz qabul qilindi! Tez orada siz bilan bog'lanamiz. Rahmat! 🙏";
      await sendInstagramMessage(senderId, customerReply);
      appendIgHistory(senderId, "assistant", customerReply);
    } else {
      appendIgHistory(senderId, "assistant", aiText);
      await sendInstagramMessage(senderId, aiText);
    }
  } catch (err) {
    console.error("[InstagramBot] Error handling message:", err);
    logger.error({ err, senderId }, "Instagram message handler error");
    await sendInstagramMessage(senderId, "Kechirasiz, hozir texnik muammo bor. Bir oz kutib qayta yozing.");
  }
}

export default router;
