import { Bot, session, Context } from "grammy";
import type { SessionFlavor } from "grammy";
import { db } from "@workspace/db";
import { usersTable, storesTable, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

interface SessionData {
  step?: "awaiting_name" | "awaiting_token" | "awaiting_catalog";
  storeName?: string;
  botToken?: string;
}

type MyContext = Context & SessionFlavor<SessionData>;

function sanitize(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[c] ?? c)
  );
}

function getServerUrl(): string | null {
  if (process.env.SERVER_URL) return process.env.SERVER_URL.replace(/\/$/, "");
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return null;
}

export function createPlatformBot(token: string) {
  const bot = new Bot<MyContext>(token);

  bot.use(session({ initial: (): SessionData => ({}) }));

  const mainKeyboard = {
    keyboard: [
      [{ text: "➕ Yangi do'kon yaratish" }],
      [{ text: "🏪 Mening do'konlarim" }],
      [{ text: "📦 Buyurtmalarni ko'rish" }],
    ],
    resize_keyboard: true,
    persistent: true,
  };

  bot.command("start", async (ctx) => {
    try {
      const tgId = BigInt(ctx.from!.id);
      const username = ctx.from?.username ?? null;
      await db
        .insert(usersTable)
        .values({ telegramId: tgId, username })
        .onConflictDoNothing();

      await ctx.reply(
        "Assalomu alaykum! Woxsom AI platformasiga xush kelibsiz! 🤖\n\nQuyidagi menyudan birini tanlang:",
        { reply_markup: mainKeyboard }
      );
    } catch (err) {
      logger.error({ err }, "Error in /start");
      await ctx.reply("Xatolik yuz berdi. Iltimos qayta urinib ko'ring.");
    }
  });

  bot.hears("➕ Yangi do'kon yaratish", async (ctx) => {
    try {
      ctx.session.step = "awaiting_name";
      ctx.session.storeName = undefined;
      ctx.session.botToken = undefined;
      await ctx.reply("Do'koningiz nomini kiriting:", { reply_markup: { remove_keyboard: true } });
    } catch (err) {
      logger.error({ err }, "Error starting store wizard");
    }
  });

  bot.hears("🏪 Mening do'konlarim", async (ctx) => {
    try {
      const tgId = BigInt(ctx.from!.id);
      const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, tgId) });
      if (!user) {
        await ctx.reply("Siz hali ro'yxatdan o'tmagansiz. /start buyrug'ini yuboring.");
        return;
      }
      const stores = await db.query.storesTable.findMany({ where: eq(storesTable.ownerId, user.id) });
      if (stores.length === 0) {
        await ctx.reply("Sizda hali do'kon yo'q. Yangi do'kon yarating!", { reply_markup: mainKeyboard });
        return;
      }
      let message = "🏪 Sizning do'konlaringiz:\n\n";
      stores.forEach((s, i) => {
        const status = s.isActive ? "✅ Faol" : "❌ Nofaol";
        message += `${i + 1}. ${sanitize(s.storeName)}\n   Bot: @${sanitize(s.botUsername)}\n   Holat: ${status}\n\n`;
      });
      await ctx.reply(message, { reply_markup: mainKeyboard });
    } catch (err) {
      logger.error({ err }, "Error listing stores");
      await ctx.reply("Xatolik yuz berdi.", { reply_markup: mainKeyboard });
    }
  });

  bot.hears("📦 Buyurtmalarni ko'rish", async (ctx) => {
    try {
      const tgId = BigInt(ctx.from!.id);
      const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, tgId) });
      if (!user) {
        await ctx.reply("Siz hali ro'yxatdan o'tmagansiz. /start buyrug'ini yuboring.");
        return;
      }
      const stores = await db.query.storesTable.findMany({ where: eq(storesTable.ownerId, user.id) });
      if (stores.length === 0) {
        await ctx.reply("Sizda hali do'kon yo'q.", { reply_markup: mainKeyboard });
        return;
      }
      const storeIds = stores.map((s) => s.id);
      let allOrders: Awaited<ReturnType<typeof db.query.ordersTable.findMany>> = [];
      for (const storeId of storeIds) {
        const storeOrders = await db.query.ordersTable.findMany({
          where: eq(ordersTable.storeId, storeId),
        });
        allOrders = allOrders.concat(storeOrders);
      }
      if (allOrders.length === 0) {
        await ctx.reply("Hali buyurtma yo'q.", { reply_markup: mainKeyboard });
        return;
      }
      allOrders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const recent = allOrders.slice(0, 10);
      let message = "📦 So'nggi buyurtmalar:\n\n";
      for (const order of recent) {
        const store = stores.find((s) => s.id === order.storeId);
        message +=
          `🔹 Do'kon: ${sanitize(store?.storeName ?? "?")}\n` +
          `   Mijoz: ${sanitize(order.customerName)}\n` +
          `   Tel: ${sanitize(order.customerPhone)}\n` +
          `   Manzil: ${sanitize(order.customerAddress)}\n` +
          `   Summa: ${order.totalPrice} so'm\n` +
          `   Holat: ${order.status}\n` +
          `   Sana: ${order.createdAt.toLocaleDateString("uz-UZ")}\n\n`;
      }
      await ctx.reply(message, { reply_markup: mainKeyboard });
    } catch (err) {
      logger.error({ err }, "Error viewing orders");
      await ctx.reply("Xatolik yuz berdi.", { reply_markup: mainKeyboard });
    }
  });

  bot.on("message:text", async (ctx) => {
    const step = ctx.session.step;
    const text = ctx.message.text;

    if (!step) return;

    if (step === "awaiting_name") {
      ctx.session.storeName = text.trim();
      ctx.session.step = "awaiting_token";
      await ctx.reply("Telegram Bot Tokenini yuboring:");
      return;
    }

    if (step === "awaiting_token") {
      const tokenInput = text.trim();
      try {
        const validateRes = await fetch(`https://api.telegram.org/bot${tokenInput}/getMe`);
        const data = (await validateRes.json()) as { ok: boolean; result?: { username?: string } };
        if (!data.ok) {
          await ctx.reply("❌ Bot tokeni noto'g'ri. Qayta yuboring:");
          return;
        }
        ctx.session.botToken = tokenInput;
        ctx.session.step = "awaiting_catalog";
        await ctx.reply("Mahsulotlar katalogini va qoidalarini matn ko'rinishida yuboring:");
      } catch (err) {
        logger.error({ err }, "Token validation error");
        await ctx.reply("❌ Bot tokeni noto'g'ri. Qayta yuboring:");
      }
      return;
    }

    if (step === "awaiting_catalog") {
      const catalogText = text.trim();
      const tgId = BigInt(ctx.from!.id);
      const savedToken = ctx.session.botToken;
      const savedName = ctx.session.storeName;

      try {
        const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, tgId) });
        if (!user || !savedToken || !savedName) {
          await ctx.reply("❌ Xatolik: ma'lumotlar topilmadi. Qaytadan boshlang.");
          ctx.session.step = undefined;
          return;
        }

        const validateRes = await fetch(`https://api.telegram.org/bot${savedToken}/getMe`);
        const data = (await validateRes.json()) as { ok: boolean; result?: { username?: string } };
        if (!data.ok) {
          await ctx.reply("❌ Bot tokeni endi yaroqsiz. Qaytadan boshlang.");
          ctx.session.step = undefined;
          return;
        }

        const botUsername = data.result?.username ?? "unknown";
        const serverUrl = getServerUrl();

        await db.insert(storesTable).values({
          ownerId: user.id,
          botToken: savedToken,
          botUsername,
          storeName: savedName,
          contextData: catalogText,
          isActive: true,
        });

        if (serverUrl) {
          const webhookUrl = `${serverUrl}/api/webhook/store/${savedToken}`;
          const webhookRes = await fetch(`https://api.telegram.org/bot${savedToken}/setWebhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
          });
          const webhookData = (await webhookRes.json()) as { ok: boolean; description?: string };
          if (webhookData.ok) {
            logger.info({ storeName: savedName, webhookUrl }, "Store bot webhook registered");
          } else {
            logger.error({ storeName: savedName, webhookData }, "Store bot webhook registration failed");
          }
        } else {
          logger.warn({ storeName: savedName }, "SERVER_URL not set — store bot webhook not registered");
        }

        ctx.session.step = undefined;
        ctx.session.storeName = undefined;
        ctx.session.botToken = undefined;

        await ctx.reply(
          `✅ Do'koningiz muvaffaqiyatli yaratildi!\n\n` +
            `🏪 Do'kon nomi: ${sanitize(savedName)}\n` +
            `🤖 Bot: @${sanitize(botUsername)}\n\n` +
            `Mijozlaringiz shu bot orqali buyurtma bera oladi: https://t.me/${sanitize(botUsername)}`,
          { reply_markup: mainKeyboard }
        );
      } catch (err) {
        logger.error({ err }, "Error saving store");
        ctx.session.step = undefined;
        await ctx.reply("❌ Do'kon saqlashda xatolik yuz berdi. Qayta urinib ko'ring.", {
          reply_markup: mainKeyboard,
        });
      }
    }
  });

  return bot;
}
