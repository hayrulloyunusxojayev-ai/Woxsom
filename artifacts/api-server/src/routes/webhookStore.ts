import { Router } from "express";
import { db } from "@workspace/db";
import { storesTable, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";

const router = Router();

const ORDER_MARKER = "___CREATE_ORDER___";

function sanitize(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (c) => `\\${c}`);
}

async function sendTelegramMessage(botToken: string, chatId: number | bigint, text: string): Promise<void> {
  const safeText = text.slice(0, 4096);
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), text: safeText }),
    });
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

router.post("/webhook/store/:bot_token", async (req, res) => {
  res.sendStatus(200);

  const { bot_token } = req.params;
  const body = req.body as Record<string, unknown>;

  const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
  if (!message) return;

  const chatId = (message.chat as Record<string, unknown>)?.id as number;
  const userText = (message.text as string | undefined) ?? "";
  const fromId = ((message.from as Record<string, unknown>)?.id as number) ?? 0;

  if (!chatId || !userText.trim()) return;

  try {
    const store = await db.query.storesTable.findFirst({
      where: eq(storesTable.botToken, bot_token),
    });

    if (!store || !store.isActive) return;

    const systemPrompt = `Sen "${store.storeName}" do'konining professional savdo assistentisan.
Faqat ushbu katalog va narxlarga asoslanib ish yur:
---
${store.contextData}
---
Siz faqat o'zbek tilida gaplashasiz, lekin agar mijoz rus tilida yozsa, rus tilida javob bering.
Mijozdan buyurtma olish uchun ulardan quyidagilarni birma-bir so'rang:
1. Ismi
2. Telefon raqami
3. Yetkazib berish manzili
Barcha uch ma'lumot olingandan so'ng, javobingizning eng oxirida (hech qanday matn qo'shmasdan) quyidagi formatda yozing:
${ORDER_MARKER} {"name": "...", "phone": "...", "address": "...", "items": "...", "total": 0}
Iltimos, faqat katalogdagi mahsulotlar haqida gaping. Boshqa mavzularga javob bermang.`;

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    });

    const aiText = response.choices[0]?.message?.content ?? "Kechirasiz, hozir javob bera olmayapman.";

    if (aiText.includes(ORDER_MARKER)) {
      const markerIndex = aiText.indexOf(ORDER_MARKER);
      const conversationalPart = aiText.slice(0, markerIndex).trim();
      const jsonPart = aiText.slice(markerIndex + ORDER_MARKER.length).trim();

      let orderData: OrderData | null = null;
      try {
        orderData = JSON.parse(jsonPart) as OrderData;
      } catch (e) {
        logger.warn({ jsonPart }, "Failed to parse order JSON");
      }

      if (orderData) {
        try {
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

          const platformToken = process.env.PLATFORM_BOT_TOKEN!;
          const ownerNotification =
            `🔔 YANGI BUYURTMA!\n` +
            `Do'kon: ${store.storeName}\n` +
            `Mijoz: ${orderData.name}\n` +
            `Tel: ${orderData.phone}\n` +
            `Manzil: ${orderData.address}\n` +
            `Mahsulotlar: ${orderData.items}\n` +
            `Summa: ${orderData.total} so'm`;

          const ownerRow = await db.query.storesTable.findFirst({
            where: eq(storesTable.id, store.id),
          });

          if (ownerRow) {
            const { usersTable } = await import("@workspace/db");
            const owner = await db.query.usersTable.findFirst({
              where: eq(usersTable.id, ownerRow.ownerId),
            });
            if (owner) {
              await sendTelegramMessage(platformToken, owner.telegramId, ownerNotification);
            }
          }
        } catch (err) {
          logger.error({ err }, "Failed to save order");
        }
      }

      const replyText = conversationalPart || "Buyurtmangiz qabul qilindi! Ko'p rahmat!";
      await sendTelegramMessage(bot_token, chatId, replyText);
    } else {
      await sendTelegramMessage(bot_token, chatId, aiText);
    }
  } catch (err) {
    logger.error({ err }, "Error handling store webhook");
    await sendTelegramMessage(bot_token, chatId, "Kechirasiz, hozir texnik muammo bor. Keyinroq urinib ko'ring.");
  }
});

export default router;
