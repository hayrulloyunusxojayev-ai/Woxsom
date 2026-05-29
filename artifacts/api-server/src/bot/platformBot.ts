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

// Parse structured catalog: "Name | Price | Description" (one per line)
function parseCatalog(raw: string): { isValid: boolean; formatted: string; preview: string } {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const products: { name: string; price: string; desc: string }[] = [];
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split("|").map((p) => p.trim());
    if (parts.length < 3) {
      errors.push(`${i + 1}-qator noto'g'ri formatda: "${lines[i]}"`);
      continue;
    }
    products.push({ name: parts[0], price: parts[1], desc: parts.slice(2).join("|").trim() });
  }

  if (errors.length > 0) {
    return { isValid: false, formatted: raw, preview: errors.join("\n") };
  }

  const formatted = products
    .map((p) => `${p.name} | ${p.price} | ${p.desc}`)
    .join("\n");

  const preview = products
    .map((p, i) => `${i + 1}. <b>${sanitize(p.name)}</b> — ${sanitize(p.price)}\n   ${sanitize(p.desc)}`)
    .join("\n\n");

  return { isValid: true, formatted, preview };
}

export function createPlatformBot(token: string) {
  const bot = new Bot<MyContext>(token);

  bot.use(session({ initial: (): SessionData => ({}) }));

  // ── Keyboards ─────────────────────────────────────────────────────────────
  const mainKeyboard = {
    keyboard: [
      [{ text: "➕ Yangi do'kon yaratish" }],
      [{ text: "🏪 Mening do'konlarim" }],
      [{ text: "📦 Buyurtmalarni ko'rish" }],
    ],
    resize_keyboard: true,
    persistent: true,
  };

  const cancelKeyboard = {
    keyboard: [[{ text: "❌ Bekor qilish" }]],
    resize_keyboard: true,
  };

  // ── /start ────────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    try {
      const tgId = BigInt(ctx.from!.id);
      const username = ctx.from?.username ?? null;
      await db.insert(usersTable).values({ telegramId: tgId, username }).onConflictDoNothing();

      ctx.session.step = undefined;
      await ctx.reply(
        `👋 Xush kelibsiz, <b>${sanitize(ctx.from?.first_name ?? "")}</b>!\n\n` +
        `Bu <b>Woxsom AI</b> — sizning AI-savdo assistantingiz. 🤖\n\n` +
        `Quyidagi bo'limlardan birini tanlang:`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    } catch (err) {
      logger.error({ err }, "Error in /start");
      await ctx.reply("Xatolik yuz berdi. Iltimos qayta urinib ko'ring.");
    }
  });

  // ── Cancel from any wizard step ───────────────────────────────────────────
  bot.hears("❌ Bekor qilish", async (ctx) => {
    ctx.session.step = undefined;
    ctx.session.storeName = undefined;
    ctx.session.botToken = undefined;
    await ctx.reply("❌ Amal bekor qilindi.", { reply_markup: mainKeyboard });
  });

  // ── Create store wizard ───────────────────────────────────────────────────
  bot.hears("➕ Yangi do'kon yaratish", async (ctx) => {
    try {
      ctx.session.step = "awaiting_name";
      ctx.session.storeName = undefined;
      ctx.session.botToken = undefined;
      await ctx.reply(
        `🏪 <b>Yangi do'kon yaratish</b>\n\n` +
        `<b>1-qadam / 3:</b> Do'koningiz nomini kiriting.\n\n` +
        `<i>Masalan: iPhone Hay, Kameliya Boutique</i>`,
        { parse_mode: "HTML", reply_markup: cancelKeyboard }
      );
    } catch (err) {
      logger.error({ err }, "Error starting store wizard");
    }
  });

  // ── My stores ─────────────────────────────────────────────────────────────
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
        await ctx.reply("Sizda hali do'kon yo'q.\nYangi do'kon yarating!", { reply_markup: mainKeyboard });
        return;
      }
      const lines = stores.map((s, i) => {
        const status = s.isActive ? "✅ Faol" : "❌ Nofaol";
        return `${i + 1}. <b>${sanitize(s.storeName)}</b>\n   🤖 @${sanitize(s.botUsername)}   ${status}`;
      });
      await ctx.reply(
        `🏪 <b>Sizning do'konlaringiz:</b>\n\n${lines.join("\n\n")}`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    } catch (err) {
      logger.error({ err }, "Error listing stores");
      await ctx.reply("Xatolik yuz berdi.", { reply_markup: mainKeyboard });
    }
  });

  // ── View orders ───────────────────────────────────────────────────────────
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

      let allOrders: Awaited<ReturnType<typeof db.query.ordersTable.findMany>> = [];
      for (const s of stores) {
        const rows = await db.query.ordersTable.findMany({ where: eq(ordersTable.storeId, s.id) });
        allOrders = allOrders.concat(rows);
      }

      if (allOrders.length === 0) {
        await ctx.reply("Hali buyurtma yo'q.", { reply_markup: mainKeyboard });
        return;
      }

      allOrders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const recent = allOrders.slice(0, 10);

      const statusEmoji: Record<string, string> = {
        PENDING: "🕐", PAID: "✅", SHIPPED: "🚚", DELIVERED: "📬", CANCELLED: "❌",
      };

      const lines = recent.map((o) => {
        const store = stores.find((s) => s.id === o.storeId);
        const emoji = statusEmoji[o.status] ?? "📋";
        return (
          `${emoji} <b>${sanitize(o.customerName)}</b> — ${o.totalPrice} so'm\n` +
          `   🏪 ${sanitize(store?.storeName ?? "?")}  |  📅 ${o.createdAt.toLocaleDateString("uz-UZ")}\n` +
          `   📞 ${sanitize(o.customerPhone)}  |  📍 ${sanitize(o.customerAddress)}`
        );
      });

      await ctx.reply(
        `📦 <b>So'nggi ${recent.length} ta buyurtma:</b>\n\n${lines.join("\n\n")}`,
        { parse_mode: "HTML", reply_markup: mainKeyboard }
      );
    } catch (err) {
      logger.error({ err }, "Error viewing orders");
      await ctx.reply("Xatolik yuz berdi.", { reply_markup: mainKeyboard });
    }
  });

  // ── Wizard step handler ───────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    const step = ctx.session.step;
    const text = ctx.message.text.trim();

    if (!step) return;

    // ── Step 1: Store name ─────────────────────────────────────────────────
    if (step === "awaiting_name") {
      if (text.length < 2 || text.length > 60) {
        await ctx.reply("⚠️ Do'kon nomi 2–60 belgi orasida bo'lishi kerak. Qayta kiriting:");
        return;
      }
      ctx.session.storeName = text;
      ctx.session.step = "awaiting_token";
      await ctx.reply(
        `✅ Do'kon nomi: <b>${sanitize(text)}</b>\n\n` +
        `<b>2-qadam / 3:</b> Telegram Bot Tokenini yuboring.\n\n` +
        `💡 Token olish uchun: @BotFather → /newbot → tokenni nusxalab yuboring.\n` +
        `<i>Misol: 123456789:AAFabc...</i>`,
        { parse_mode: "HTML", reply_markup: cancelKeyboard }
      );
      return;
    }

    // ── Step 2: Bot token ──────────────────────────────────────────────────
    if (step === "awaiting_token") {
      await ctx.reply("⏳ Token tekshirilmoqda...");
      try {
        const validateRes = await fetch(`https://api.telegram.org/bot${text}/getMe`);
        const data = (await validateRes.json()) as { ok: boolean; result?: { username?: string; first_name?: string } };
        if (!data.ok) {
          await ctx.reply(
            "❌ Bu token yaroqsiz. Iltimos @BotFather dan to'g'ri tokenni olib, qayta yuboring:",
            { reply_markup: cancelKeyboard }
          );
          return;
        }
        ctx.session.botToken = text;
        ctx.session.step = "awaiting_catalog";
        await ctx.reply(
          `✅ Bot topildi: <b>${sanitize(data.result?.first_name ?? "")} (@${sanitize(data.result?.username ?? "")})</b>\n\n` +
          `<b>3-qadam / 3:</b> Mahsulotlar katalogini quyidagi formatda yuboring:\n\n` +
          `<code>Mahsulot nomi | Narxi | Tavsifi\n` +
          `Mahsulot nomi | Narxi | Tavsifi</code>\n\n` +
          `<b>Namuna:</b>\n` +
          `<code>iPhone 15 Pro | 12 500 000 so'm | 256GB, Titanium, 1 yil kafolat\n` +
          `AirPods Pro | 2 800 000 so'm | Shovqin o'chirish, USB-C, original</code>\n\n` +
          `⚠️ Har bir mahsulot alohida qatorda bo'lsin. | belgisini ajratuvchi sifatida ishlating.`,
          { parse_mode: "HTML", reply_markup: cancelKeyboard }
        );
      } catch (err) {
        logger.error({ err }, "Token validation error");
        await ctx.reply("❌ Server xatosi. Tokenni qayta yuboring:", { reply_markup: cancelKeyboard });
      }
      return;
    }

    // ── Step 3: Catalog ────────────────────────────────────────────────────
    if (step === "awaiting_catalog") {
      const { isValid, formatted, preview } = parseCatalog(text);

      if (!isValid) {
        await ctx.reply(
          `❌ <b>Format xatosi:</b>\n\n${sanitize(preview)}\n\n` +
          `Iltimos quyidagi formatda qayta yuboring:\n` +
          `<code>Mahsulot nomi | Narxi | Tavsifi</code>`,
          { parse_mode: "HTML", reply_markup: cancelKeyboard }
        );
        return;
      }

      const tgId = BigInt(ctx.from!.id);
      const savedToken = ctx.session.botToken;
      const savedName = ctx.session.storeName;

      try {
        const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, tgId) });
        if (!user || !savedToken || !savedName) {
          await ctx.reply("❌ Sessiya xatosi. Iltimos qaytadan boshlang.", { reply_markup: mainKeyboard });
          ctx.session.step = undefined;
          return;
        }

        const validateRes = await fetch(`https://api.telegram.org/bot${savedToken}/getMe`);
        const data = (await validateRes.json()) as { ok: boolean; result?: { username?: string } };
        if (!data.ok) {
          await ctx.reply("❌ Bot tokeni endi yaroqsiz. Qaytadan boshlang.", { reply_markup: mainKeyboard });
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
          contextData: formatted,
          isActive: true,
        });

        if (serverUrl) {
          const webhookUrl = `${serverUrl}/api/webhook/store/${savedToken}`;
          const webhookRes = await fetch(`https://api.telegram.org/bot${savedToken}/setWebhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
          });
          const webhookData = (await webhookRes.json()) as { ok: boolean };
          if (webhookData.ok) {
            logger.info({ storeName: savedName, webhookUrl }, "Store bot webhook registered");
          } else {
            logger.error({ storeName: savedName, webhookData }, "Store bot webhook registration failed");
          }
        }

        ctx.session.step = undefined;
        ctx.session.storeName = undefined;
        ctx.session.botToken = undefined;

        await ctx.reply(
          `🎉 <b>Do'kon muvaffaqiyatli yaratildi!</b>\n\n` +
          `🏪 <b>${sanitize(savedName)}</b>\n` +
          `🤖 @${sanitize(botUsername)}\n\n` +
          `<b>Katalog (${formatted.split("\n").length} ta mahsulot):</b>\n${preview}\n\n` +
          `🔗 Mijozlar uchun havola: https://t.me/${sanitize(botUsername)}`,
          { parse_mode: "HTML", reply_markup: mainKeyboard }
        );
      } catch (err) {
        logger.error({ err }, "Error saving store");
        ctx.session.step = undefined;
        await ctx.reply("❌ Saqlashda xatolik yuz berdi. Qayta urinib ko'ring.", { reply_markup: mainKeyboard });
      }
    }
  });

  return bot;
}
