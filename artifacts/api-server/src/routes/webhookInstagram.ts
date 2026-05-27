import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { storesTable, ordersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";

const router = Router();

const MODEL = "Qwen/Qwen2.5-72B-Instruct";
const ORDER_MARKER = "___CREATE_ORDER___";
const GRAPH_API_BASE = "https://graph.facebook.com/v25.0";

// In-memory conversation history — key: "instagram:{senderId}:{recipientId}"
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
const igHistory = new Map<string, ChatMessage[]>();

function igKey(senderId: string, recipientId: string): string {
  return `instagram:${senderId}:${recipientId}`;
}

function getIgHistory(senderId: string, recipientId: string): ChatMessage[] {
  const key = igKey(senderId, recipientId);
  if (!igHistory.has(key)) igHistory.set(key, []);
  return igHistory.get(key)!;
}

function appendIgHistory(senderId: string, recipientId: string, role: "user" | "assistant", content: string): void {
  getIgHistory(senderId, recipientId).push({ role, content });
}

function clearIgHistory(senderId: string, recipientId: string): void {
  igHistory.delete(igKey(senderId, recipientId));
}

async function sendInstagramMessage(
  pageId: string,
  recipientId: string,
  text: string,
  accessToken: string
): Promise<void> {
  // Must POST to /{ig-business-account-id}/messages — NOT /me/messages (that's legacy Messenger)
  const url = `${GRAPH_API_BASE}/${pageId}/messages`;
  const payload = {
    recipient: { id: recipientId },
    message: { text: text.slice(0, 2000) },
  };
  console.log(`[InstagramBot] Sending reply → POST ${url}`);
  console.log(`[InstagramBot] Payload: recipient=${recipientId} text="${text.slice(0, 80)}..."`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, access_token: accessToken }),
    });
    const responseBody = await res.text();
    if (!res.ok) {
      console.error(`[InstagramBot] ❌ Send failed — HTTP ${res.status}: ${responseBody}`);
      logger.warn({ recipientId, pageId, status: res.status, body: responseBody }, "Instagram sendMessage failed");
    } else {
      console.log(`[InstagramBot] ✅ Reply sent — HTTP ${res.status}: ${responseBody}`);
      logger.info({ recipientId, pageId, status: res.status }, "Instagram sendMessage succeeded");
    }
  } catch (err) {
    console.error(`[InstagramBot] ❌ Network error sending to ${recipientId}:`, err);
    logger.error({ err, recipientId, pageId }, "Instagram sendMessage network error");
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

// Resolve the store for an Instagram Page ID.
// Priority: store with matching instagramPageId → INSTAGRAM_STORE_BOT_TOKEN env → first active store.
async function resolveStore(recipientId: string) {
  const byPageId = await db.query.storesTable.findFirst({
    where: eq(storesTable.instagramPageId, recipientId),
  });
  if (byPageId) return byPageId;

  const envToken = process.env.INSTAGRAM_STORE_BOT_TOKEN;
  if (envToken) {
    return db.query.storesTable.findFirst({ where: eq(storesTable.botToken, envToken) });
  }

  return db.query.storesTable.findFirst({ where: eq(storesTable.isActive, true) });
}

// GET /api/webhook/instagram — Meta verification handshake
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

// POST /api/webhook/instagram — incoming DM events from Meta
router.post("/webhook/instagram", async (req: Request, res: Response) => {
  // Acknowledge immediately so Meta does not retry
  res.status(200).send("OK");

  const body = req.body as Record<string, unknown>;

  if (body.object !== "instagram") return;

  const entries = body.entry as Array<Record<string, unknown>> | undefined;
  if (!entries?.length) return;

  for (const entry of entries) {
    const recipientId = (entry.id as string | undefined) ?? "";
    const messaging = entry.messaging as Array<Record<string, unknown>> | undefined;
    if (!messaging?.length) continue;

    for (const event of messaging) {
      const sender = (event.sender as Record<string, unknown> | undefined)?.id as string | undefined;
      const recipient = (event.recipient as Record<string, unknown> | undefined)?.id as string | undefined;
      const messageObj = event.message as Record<string, unknown> | undefined;
      const userText = (messageObj?.text as string | undefined)?.trim();

      if (!sender || !userText) continue;

      // Echo guard: ignore messages the page sent to itself
      if (messageObj?.is_echo) continue;
      if (sender === recipientId || sender === recipient) {
        logger.info({ senderId: sender }, "Instagram: skipping own-page echo message");
        continue;
      }

      // entry.id is the Instagram Page ID in live events (primary source).
      // Fall back to event.recipient.id only when entry.id is absent.
      const pageId = recipientId || recipient || "";

      console.log("[InstagramBot] Incoming event — pageId:", pageId, "| senderId:", sender, "| text:", userText);
      logger.info({ senderId: sender, pageId, textLength: userText.length }, "Instagram DM received");

      handleInstagramMessage(sender, pageId, userText).catch((err) => {
        console.error("[InstagramBot] Unhandled error:", err);
      });
    }
  }
});

async function handleInstagramMessage(senderId: string, recipientPageId: string, userText: string): Promise<void> {
  try {
    const store = await resolveStore(recipientPageId);
    if (!store || !store.isActive) {
      logger.warn({ senderId, recipientPageId }, "No active store found for Instagram Page ID");
      return;
    }

    // Use store-specific token if available, fall back to global env var
    const accessToken = store.instagramToken ?? process.env.INSTAGRAM_PAGE_ACCESS_TOKEN ?? "";
    if (!accessToken) {
      logger.error({ storeId: store.id }, "No Instagram access token available — cannot reply");
      return;
    }

    appendIgHistory(senderId, recipientPageId, "user", userText);
    const recentHistory = getIgHistory(senderId, recipientPageId).slice(-6);

    const llmStart = Date.now();
    const response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 256,
      messages: [
        { role: "system", content: buildSystemPrompt(store.storeName, store.contextData) },
        ...recentHistory,
      ],
    });
    const llmMs = Date.now() - llmStart;

    const aiText = (response.choices[0]?.message?.content ?? "").trim();
    logger.info({ senderId, aiTextLength: aiText.length, llmMs, model: MODEL }, "Instagram LLM response");

    console.log(`[InstagramBot] LLM reply (${llmMs}ms): "${aiText.slice(0, 120)}"`);

    if (!aiText) {
      logger.warn({ senderId }, "Empty LLM response for Instagram message");
      await sendInstagramMessage(recipientPageId, senderId, "Kechirasiz, qayta yuboring.", accessToken);
      return;
    }

    const { reply, order } = extractOrder(aiText);

    if (order) {
      const senderBigInt = BigInt(senderId);

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

      clearIgHistory(senderId, recipientPageId);

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

      const customerReply = reply || "✅ Buyurtmangiz qabul qilindi! Tez orada siz bilan bog'lanamiz. Rahmat! 🙏";
      await sendInstagramMessage(recipientPageId, senderId, customerReply, accessToken);
      appendIgHistory(senderId, recipientPageId, "assistant", customerReply);
    } else {
      appendIgHistory(senderId, recipientPageId, "assistant", aiText);
      await sendInstagramMessage(recipientPageId, senderId, aiText, accessToken);
    }
  } catch (err) {
    console.error("[InstagramBot] Error handling message:", err);
    logger.error({ err, senderId }, "Instagram message handler error");
    await sendInstagramMessage(
      recipientPageId,
      senderId,
      "Kechirasiz, hozir texnik muammo bor. Bir oz kutib qayta yozing.",
      process.env.INSTAGRAM_PAGE_ACCESS_TOKEN ?? ""
    );
  }
}

export default router;
