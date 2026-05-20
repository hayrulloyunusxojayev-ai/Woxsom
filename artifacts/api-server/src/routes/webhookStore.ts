import { Router } from "express";
import { db } from "@workspace/db";
import { storesTable, ordersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";

const router = Router();

const ORDER_MARKER = "___CREATE_ORDER___";

// In-memory conversation history: key = "botToken:chatId"
// Each entry holds the last N message pairs so the AI never loses context.
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
const conversationHistory = new Map<string, ChatMessage[]>();
const MAX_HISTORY_PAIRS = 10; // keep last 10 pairs = 20 messages

function getHistoryKey(botToken: string, chatId: number): string {
  return `${botToken}:${chatId}`;
}

function getHistory(botToken: string, chatId: number): ChatMessage[] {
  const key = getHistoryKey(botToken, chatId);
  if (!conversationHistory.has(key)) {
    conversationHistory.set(key, []);
  }
  return conversationHistory.get(key)!;
}

function pushHistory(botToken: string, chatId: number, role: "user" | "assistant", content: string): void {
  const history = getHistory(botToken, chatId);
  history.push({ role, content });
  // Trim to keep only the last MAX_HISTORY_PAIRS pairs
  if (history.length > MAX_HISTORY_PAIRS * 2) {
    history.splice(0, history.length - MAX_HISTORY_PAIRS * 2);
  }
}

function clearHistory(botToken: string, chatId: number): void {
  conversationHistory.delete(getHistoryKey(botToken, chatId));
}

async function sendTelegramMessage(botToken: string, chatId: number | bigint, text: string): Promise<void> {
  const safeText = text.slice(0, 4096);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), text: safeText }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      logger.warn({ chatId, errBody }, "Telegram sendMessage non-200");
    }
  } catch (err) {
    logger.error({ err, chatId }, "Failed to send Telegram message");
  }
}

interface OrderData {
  name: string;
  phone: string;
  address: string;
  items: string;
  total: number;
}

function extractOrderData(aiText: string): { conversationalPart: string; orderData: OrderData | null } {
  const markerIndex = aiText.indexOf(ORDER_MARKER);
  if (markerIndex === -1) {
    return { conversationalPart: aiText.trim(), orderData: null };
  }

  const conversationalPart = aiText.slice(0, markerIndex).trim();
  const afterMarker = aiText.slice(markerIndex + ORDER_MARKER.length).trim();

  // Robustly find the JSON block — handles extra whitespace or trailing text
  const jsonMatch = afterMarker.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    logger.warn({ afterMarker }, "ORDER_MARKER found but no JSON block detected");
    return { conversationalPart, orderData: null };
  }

  try {
    const orderData = JSON.parse(jsonMatch[0]) as OrderData;
    // Validate required fields
    if (!orderData.name || !orderData.phone || !orderData.address) {
      logger.warn({ orderData }, "Order JSON missing required fields");
      return { conversationalPart, orderData: null };
    }
    return { conversationalPart, orderData };
  } catch (e) {
    logger.warn({ raw: jsonMatch[0] }, "Failed to parse order JSON");
    return { conversationalPart, orderData: null };
  }
}

function buildSystemPrompt(storeName: string, contextData: string): string {
  return `Siz "${storeName}" do'konining yulduz savdo assistentisiz. Sizning ismingiz "Woxsom AI".

=== DO'KON KATALOGI ===
${contextData}
=== KATALOG TUGADI ===

=== QOIDLAR (MAJBURIY) ===
1. TIL: O'zbek tilida muloqot qiling. Agar mijoz RUS tilida yozsa — darhol rus tiliga o'ting va rus tilida davom eting.
2. SALOMLASHISH: Faqat bir marta salomlashing. Agar allaqachon salomlashgan bo'lsangiz — HECH QACHON qayta salomlashmang. To'g'ridan-to'g'ri mavzuga o'ting.
3. UZUNLIK: Javoblaringiz QISQA va ANIQ bo'lsin — maksimal 2-3 jumla. Ortiqcha so'z ishlatmang.
4. USLUB: Juda muloyim va hurmatli (Aka, Opa, Xursandmiz kabi so'zlar ishlating). Lekin samarali va tez.
5. FAQAT KATALOG: Faqat katalogdagi mahsulotlar haqida gapirsangiz. Boshqa mavzularga javob bermang.
6. BUYURTMA JARAYONI:
   - Mijoz mahsulot so'raganda yoki buyurtma berishga tayyor bo'lganda — ulardan quyidagilarni SO'RANG:
     a) Ism (to'liq)
     b) Telefon raqami
     c) Yetkazib berish manzili
   - Har bir ma'lumotni alohida so'rab ketavering. Agar mijoz bir xabarda barini bersa — barchasini qabul qiling.
   - Barcha uch ma'lumot olingandan so'ng — DARHOL buyurtmani yakunlang.
7. BUYURTMANI YAKUNLASH: Barcha ma'lumotlar to'liq bo'lganda, javobingizning eng OXIRIDA (hech qanday qo'shimcha matn qo'shmasdan) quyidagi blokning AYNAN shunday yozing:
${ORDER_MARKER} {"name": "ISM", "phone": "TELEFON", "address": "MANZIL", "items": "MAHSULOTLAR", "total": SUMMA}
8. TAKRORLASH YO'Q: Agar mijoz ma'lumot bergan bo'lsa — qayta so'ramang. Davom eting.`;
}

router.post("/webhook/store/:bot_token", async (req, res) => {
  // Respond immediately to Telegram to prevent retries
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
    // Load store + owner in parallel for speed
    const store = await db.query.storesTable.findFirst({
      where: eq(storesTable.botToken, bot_token),
    });

    if (!store || !store.isActive) return;

    // Build message history for this conversation
    const history = getHistory(bot_token, chatId);
    pushHistory(bot_token, chatId, "user", userText);

    const systemPrompt = buildSystemPrompt(store.storeName, store.contextData);

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 180,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.slice(0, -1), // history before current message
        { role: "user", content: userText },
      ],
    });

    const aiText = (response.choices[0]?.message?.content ?? "").trim();

    if (!aiText) {
      await sendTelegramMessage(bot_token, chatId, "Kechirasiz, hozir javob bera olmayapman.");
      return;
    }

    const { conversationalPart, orderData } = extractOrderData(aiText);

    if (orderData) {
      // 1. Commit order to DB first — fully awaited before any notification
      await db.insert(ordersTable).values({
        storeId: store.id,
        customerTgId: BigInt(fromId),
        customerName: orderData.name,
        customerPhone: orderData.phone,
        customerAddress: orderData.address,
        orderItems: { items: orderData.items },
        totalPrice: String(orderData.total ?? 0),
        status: "PENDING",
      });

      logger.info({ storeId: store.id, customerName: orderData.name }, "Order saved to DB");

      // 2. Clear conversation history so next session starts fresh
      clearHistory(bot_token, chatId);

      // 3. Look up store owner and send push notification
      const owner = await db.query.usersTable.findFirst({
        where: eq(usersTable.id, store.ownerId),
      });

      if (owner) {
        const platformToken = process.env.PLATFORM_BOT_TOKEN;
        if (platformToken) {
          const ownerNotification =
            `🔔 YANGI BUYURTMA!\n\n` +
            `🏪 Do'kon: ${store.storeName}\n` +
            `👤 Mijoz: ${orderData.name}\n` +
            `📞 Tel: ${orderData.phone}\n` +
            `📍 Manzil: ${orderData.address}\n` +
            `🛒 Mahsulotlar: ${orderData.items}\n` +
            `💰 Summa: ${orderData.total} so'm`;
          await sendTelegramMessage(platformToken, owner.telegramId, ownerNotification);
        }
      }

      // 4. Reply to customer — clean conversational part only
      const customerReply =
        conversationalPart ||
        "✅ Buyurtmangiz qabul qilindi! Tez orada siz bilan bog'lanamiz. Ko'p rahmat, Aka/Opa! 🙏";
      await sendTelegramMessage(bot_token, chatId, customerReply);

      // 5. Record the assistant reply in history (new session)
      pushHistory(bot_token, chatId, "assistant", customerReply);
    } else {
      // Normal conversation — store AI reply in history and send
      pushHistory(bot_token, chatId, "assistant", aiText);
      await sendTelegramMessage(bot_token, chatId, aiText);
    }
  } catch (err) {
    logger.error({ err }, "Error handling store webhook");
    try {
      await sendTelegramMessage(
        bot_token,
        chatId,
        "Kechirasiz, hozir texnik muammo bor. Bir oz kutib qayta yozing."
      );
    } catch {
      // swallow secondary error
    }
  }
});

export default router;
