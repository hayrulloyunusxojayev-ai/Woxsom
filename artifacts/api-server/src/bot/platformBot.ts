import { Bot, session, Context } from "grammy";
import type { SessionFlavor } from "grammy";
import { db } from "@workspace/db";
import { usersTable, storesTable, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

interface SessionData {
  step?: "awaiting_name" | "awaiting_token" | "awaiting_catalog" | "editing_catalog";
  storeName?: string;
  botToken?: string;
  editingStoreId?: string;
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

function parseCatalog(raw: string): { isValid: boolean; formatted: string; preview: string } {
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const products: { name: string; price: string; desc: string }[] = [];
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split("|").map(p => p.trim());
    if (parts.length < 3) { errors.push(`${i + 1}-qator noto'g'ri: "${lines[i]}"`); continue; }
    products.push({ name: parts[0], price: parts[1], desc: parts.slice(2).join("|").trim() });
  }

  if (errors.length) return { isValid: false, formatted: raw, preview: errors.join("\n") };

  const formatted = products.map(p => `${p.name} | ${p.price} | ${p.desc}`).join("\n");
  const preview = products
    .map((p, i) => `${i + 1}. <b>${sanitize(p.name)}</b> — ${sanitize(p.price)}\n   ${sanitize(p.desc)}`)
    .join("\n\n");
  return { isValid: true, formatted, preview };
}

// Inline keyboard type alias
type IKBtn = { text: string; callback_data: string };

const START_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "➕ Yangi do'kon", callback_data: "nav:new_store" },
      { text: "🏪 Do'konlarim", callback_data: "nav:stores" },
    ],
    [{ text: "📦 Buyurtmalar", callback_data: "nav:orders" }],
  ] as IKBtn[][],
};

const CANCEL_KEYBOARD = {
  keyboard: [[{ text: "❌ Bekor qilish" }]],
  resize_keyboard: true,
};

export function createPlatformBot(token: string) {
  const bot = new Bot<MyContext>(token);
  bot.use(session({ initial: (): SessionData => ({}) }));

  // ── /start ────────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    try {
      const tgId = BigInt(ctx.from!.id);
      await db.insert(usersTable)
        .values({ telegramId: tgId, username: ctx.from?.username ?? null })
        .onConflictDoNothing();
      ctx.session.step = undefined;

      // Remove any existing reply keyboard first, then show inline menu
      await ctx.reply("🤖 Woxsom AI", { reply_markup: { remove_keyboard: true } });
      await ctx.reply(
        `👋 Xush kelibsiz, <b>${sanitize(ctx.from?.first_name ?? "")}</b>!\n\n` +
        `Quyidagi bo'limlardan birini tanlang:`,
        { parse_mode: "HTML", reply_markup: START_KEYBOARD }
      );
    } catch (err) { logger.error({ err }, "Error in /start"); }
  });

  // ── Cancel wizard ─────────────────────────────────────────────────────────
  bot.hears("❌ Bekor qilish", async (ctx) => {
    ctx.session.step = undefined;
    ctx.session.storeName = undefined;
    ctx.session.botToken = undefined;
    ctx.session.editingStoreId = undefined;
    await ctx.reply("❌ Amal bekor qilindi.", { reply_markup: { remove_keyboard: true } });
    await ctx.reply("Bo'limni tanlang:", { reply_markup: START_KEYBOARD });
  });

  // ── Callback query handler ────────────────────────────────────────────────
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();
    try {

    // ── nav:new_store ───────────────────────────────────────────────────────
    if (data === "nav:new_store") {
      ctx.session.step = "awaiting_name";
      ctx.session.storeName = undefined;
      ctx.session.botToken = undefined;
      await ctx.reply(
        `🏪 <b>Yangi do'kon yaratish</b>\n\n` +
        `<b>1-qadam / 3:</b> Do'koningiz nomini kiriting.\n` +
        `<i>Masalan: iPhone Hay, Kameliya Boutique</i>`,
        { parse_mode: "HTML", reply_markup: CANCEL_KEYBOARD }
      );
      return;
    }

    // ── nav:stores ──────────────────────────────────────────────────────────
    if (data === "nav:stores") {
      const tgId = BigInt(ctx.from.id);
      const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, tgId) });
      if (!user) { await ctx.reply("Avval /start buyrug'ini yuboring."); return; }

      const stores = await db.query.storesTable.findMany({ where: eq(storesTable.ownerId, user.id) });
      if (!stores.length) {
        await ctx.editMessageText("Sizda hali do'kon yo'q.", {
          reply_markup: {
            inline_keyboard: [[{ text: "➕ Do'kon yaratish", callback_data: "nav:new_store" }]],
          },
        });
        return;
      }

      const rows: IKBtn[][] = stores.map(s => [{
        text: `${s.isActive ? "✅" : "❌"} ${s.storeName}`,
        callback_data: `store:${s.id}`,
      }]);
      rows.push([{ text: "🔙 Orqaga", callback_data: "nav:back" }]);

      await ctx.editMessageText("🏪 <b>Sizning do'konlaringiz:</b>", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      });
      return;
    }

    // ── nav:orders ──────────────────────────────────────────────────────────
    if (data === "nav:orders") {
      const tgId = BigInt(ctx.from.id);
      const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, tgId) });
      if (!user) { await ctx.reply("Avval /start buyrug'ini yuboring."); return; }

      const stores = await db.query.storesTable.findMany({ where: eq(storesTable.ownerId, user.id) });
      if (!stores.length) {
        await ctx.editMessageText("Sizda do'kon yo'q — buyurtmalar yo'q.", {
          reply_markup: { inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "nav:back" }]] },
        });
        return;
      }

      let allOrders: Awaited<ReturnType<typeof db.query.ordersTable.findMany>> = [];
      for (const s of stores) {
        const rows = await db.query.ordersTable.findMany({
          where: eq(ordersTable.storeId, s.id),
          orderBy: (t, { desc }) => [desc(t.createdAt)],
          limit: 10,
        });
        allOrders = allOrders.concat(rows);
      }
      allOrders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const recent = allOrders.slice(0, 10);

      if (!recent.length) {
        await ctx.editMessageText("Hali buyurtma yo'q.", {
          reply_markup: { inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: "nav:back" }]] },
        });
        return;
      }

      const statusEmoji: Record<string, string> = {
        PENDING: "🕐", PAID: "✅", SHIPPED: "🚚", DELIVERED: "📬", CANCELLED: "❌",
      };

      const lines = recent.map((o, i) => {
        const store = stores.find(s => s.id === o.storeId);
        return (
          `${i + 1}. ${statusEmoji[o.status] ?? "📋"} <b>${sanitize(o.customerName)}</b>\n` +
          `   🏪 ${sanitize(store?.storeName ?? "?")}  |  💰 ${o.totalPrice} so'm\n` +
          `   📞 ${sanitize(o.customerPhone)}  |  📅 ${o.createdAt.toLocaleDateString("uz-UZ")}`
        );
      });

      const rows: IKBtn[][] = recent.map(o => [{
        text: `⚙️ Status — ${sanitize(o.customerName).slice(0, 20)}`,
        callback_data: `order:${o.id}:status`,
      }]);
      rows.push([{ text: "🔙 Orqaga", callback_data: "nav:back" }]);

      await ctx.editMessageText(
        `📦 <b>So'nggi ${recent.length} ta buyurtma:</b>\n\n${lines.join("\n\n")}`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } }
      );
      return;
    }

    // ── nav:back ────────────────────────────────────────────────────────────
    if (data === "nav:back") {
      await ctx.editMessageText(
        `👋 <b>Bosh menyu</b>\n\nBo'limni tanlang:`,
        { parse_mode: "HTML", reply_markup: START_KEYBOARD }
      );
      return;
    }

    // ── store:{id} — store detail menu ───────────────────────────────────────
    if (data.startsWith("store:") && data.split(":").length === 2) {
      const storeId = data.split(":")[1];
      const store = await db.query.storesTable.findFirst({ where: eq(storesTable.id, storeId) });
      if (!store) { await ctx.reply("Do'kon topilmadi."); return; }

      const status = store.isActive ? "✅ Faol" : "❌ Nofaol";
      await ctx.editMessageText(
        `🏪 <b>${sanitize(store.storeName)}</b>\n🤖 @${sanitize(store.botUsername)}\n📊 Holat: ${status}`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✏️ O'zgartirish", callback_data: `store:${storeId}:edit` },
                { text: "🗑 O'chirish", callback_data: `store:${storeId}:delete` },
              ],
              [{ text: "🛒 Mahsulotlar", callback_data: `store:${storeId}:products` }],
              [{ text: "🔙 Do'konlar", callback_data: "nav:stores" }],
            ],
          },
        }
      );
      return;
    }

    // ── store:{id}:products ──────────────────────────────────────────────────
    if (data.startsWith("store:") && data.endsWith(":products")) {
      const storeId = data.split(":")[1];
      const store = await db.query.storesTable.findFirst({ where: eq(storesTable.id, storeId) });
      if (!store) return;

      const lines = store.contextData.split("\n").map(l => l.trim()).filter(Boolean);
      const products = lines.map((l, i) => {
        const parts = l.split("|").map(p => p.trim());
        return `${i + 1}. <b>${sanitize(parts[0] ?? "")}</b> — ${sanitize(parts[1] ?? "")}${parts[2] ? `\n   ${sanitize(parts[2])}` : ""}`;
      });

      await ctx.editMessageText(
        `🛒 <b>${sanitize(store.storeName)} — Mahsulotlar (${products.length} ta)</b>\n\n${products.join("\n\n")}`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 Orqaga", callback_data: `store:${storeId}` }]],
          },
        }
      );
      return;
    }

    // ── store:{id}:edit ──────────────────────────────────────────────────────
    if (data.startsWith("store:") && data.endsWith(":edit")) {
      const storeId = data.split(":")[1];
      ctx.session.step = "editing_catalog";
      ctx.session.editingStoreId = storeId;
      await ctx.reply(
        `✏️ <b>Katalogni yangilash</b>\n\n` +
        `Yangi katalogni quyidagi formatda yuboring:\n\n` +
        `<code>Mahsulot nomi | Narxi | Tavsifi</code>\n\n` +
        `<b>Namuna:</b>\n<code>iPhone 15 Pro | 12 500 000 so'm | 256GB, kafolat 1 yil</code>`,
        { parse_mode: "HTML", reply_markup: CANCEL_KEYBOARD }
      );
      return;
    }

    // ── store:{id}:delete — confirm ───────────────────────────────────────────
    if (data.startsWith("store:") && data.endsWith(":delete")) {
      const storeId = data.split(":")[1];
      const store = await db.query.storesTable.findFirst({ where: eq(storesTable.id, storeId) });
      if (!store) return;
      await ctx.editMessageText(
        `🗑 <b>${sanitize(store.storeName)}</b> do'konini o'chirmoqchimisiz?\n\n⚠️ Bu amalni qaytarib bo'lmaydi!`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Ha, o'chir", callback_data: `store:${storeId}:del_confirm` },
                { text: "❌ Yo'q", callback_data: `store:${storeId}` },
              ],
            ],
          },
        }
      );
      return;
    }

    // ── store:{id}:del_confirm — execute delete ───────────────────────────────
    if (data.startsWith("store:") && data.endsWith(":del_confirm")) {
      // Extract storeId robustly — everything between "store:" and the last ":"
      const storeId = data.slice("store:".length, data.lastIndexOf(":"));
      const store = await db.query.storesTable.findFirst({ where: eq(storesTable.id, storeId) });
      if (!store) {
        await ctx.editMessageText("❌ Do'kon topilmadi yoki allaqachon o'chirilgan.", {
          reply_markup: { inline_keyboard: [[{ text: "🔙 Do'konlar", callback_data: "nav:stores" }]] },
        });
        return;
      }

      // 1. Unregister Telegram webhook (best-effort)
      await fetch(`https://api.telegram.org/bot${store.botToken}/deleteWebhook`, { method: "POST" }).catch(() => {});

      // 2. Delete child orders first to satisfy FK constraint
      await db.delete(ordersTable).where(eq(ordersTable.storeId, storeId));

      // 3. Delete the store
      await db.delete(storesTable).where(eq(storesTable.id, storeId));

      logger.info({ storeId, storeName: store.storeName }, "Store deleted");

      await ctx.editMessageText(
        `✅ <b>${sanitize(store.storeName)}</b> do'koni muvaffaqiyatli o'chirildi.`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "🔙 Do'konlarim", callback_data: "nav:stores" }]] },
        }
      );
      return;
    }

    // ── order:{id}:status — show status options ────────────────────────────
    if (data.startsWith("order:") && data.endsWith(":status")) {
      const orderId = data.split(":")[1];
      const order = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      if (!order) { await ctx.reply("Buyurtma topilmadi."); return; }

      await ctx.editMessageText(
        `⚙️ <b>${sanitize(order.customerName)}</b> buyurtmasi uchun yangi status tanlang:\n\n` +
        `📍 Hozirgi: <b>${order.status}</b>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ To'langan", callback_data: `order:${orderId}:set:PAID` },
                { text: "🚚 Yetkazilmoqda", callback_data: `order:${orderId}:set:SHIPPED` },
              ],
              [
                { text: "📬 Yetkazildi", callback_data: `order:${orderId}:set:DELIVERED` },
                { text: "❌ Bekor qilish", callback_data: `order:${orderId}:set:CANCELLED` },
              ],
              [{ text: "🔙 Buyurtmalarga", callback_data: "nav:orders" }],
            ],
          },
        }
      );
      return;
    }

    // ── order:{id}:set:{STATUS} — update DB ───────────────────────────────
    if (data.startsWith("order:") && data.includes(":set:")) {
      const parts = data.split(":");
      // format: order:{id}:set:{STATUS}  — id is uuid with 4 dashes → parts[1] is uuid
      const orderId = parts[1];
      const newStatus = parts[3] as string;

      const validStatuses = ["PAID", "SHIPPED", "DELIVERED", "CANCELLED"];
      if (!validStatuses.includes(newStatus)) return;

      await db.update(ordersTable)
        .set({ status: newStatus as "PAID" | "SHIPPED" | "DELIVERED" | "CANCELLED" })
        .where(eq(ordersTable.id, orderId));

      const order = await db.query.ordersTable.findFirst({ where: eq(ordersTable.id, orderId) });
      if (!order) return;

      const statusLabel: Record<string, string> = {
        PENDING: "🕐 Kutilmoqda", PAID: "✅ To'langan",
        SHIPPED: "🚚 Yetkazilmoqda", DELIVERED: "📬 Yetkazildi", CANCELLED: "❌ Bekor qilindi",
      };

      await ctx.editMessageText(
        `✅ Status yangilandi!\n\n` +
        `👤 <b>${sanitize(order.customerName)}</b>\n` +
        `📦 Yangi status: <b>${statusLabel[newStatus] ?? newStatus}</b>\n` +
        `💰 ${order.totalPrice} so'm`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "🔙 Buyurtmalarga", callback_data: "nav:orders" }]],
          },
        }
      );
      logger.info({ orderId, newStatus }, "Order status updated");
      return;
    }
    } catch (err) {
      logger.error({ err, data }, "Callback query handler error");
      try {
        await ctx.reply("❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
      } catch { /* ignore secondary error */ }
    }
  });

  // ── Wizard text handler ───────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    const step = ctx.session.step;
    const text = ctx.message.text.trim();
    if (!step) return;

    // ── Step 1: name ─────────────────────────────────────────────────────
    if (step === "awaiting_name") {
      if (text.length < 2 || text.length > 60) {
        await ctx.reply("⚠️ Do'kon nomi 2–60 belgi orasida bo'lishi kerak. Qayta kiriting:");
        return;
      }
      ctx.session.storeName = text;
      ctx.session.step = "awaiting_token";
      await ctx.reply(
        `✅ <b>${sanitize(text)}</b>\n\n` +
        `<b>2-qadam / 3:</b> Telegram Bot Tokenini yuboring.\n` +
        `💡 @BotFather → /newbot → tokenni nusxalab yuboring.\n` +
        `<i>Misol: 123456789:AAFabc...</i>`,
        { parse_mode: "HTML", reply_markup: CANCEL_KEYBOARD }
      );
      return;
    }

    // ── Step 2: token ────────────────────────────────────────────────────
    if (step === "awaiting_token") {
      await ctx.reply("⏳ Token tekshirilmoqda...");
      try {
        const r = await fetch(`https://api.telegram.org/bot${text}/getMe`);
        const d = await r.json() as { ok: boolean; result?: { username?: string; first_name?: string } };
        if (!d.ok) {
          await ctx.reply("❌ Token yaroqsiz. @BotFather dan to'g'ri tokenni olib qayta yuboring:", { reply_markup: CANCEL_KEYBOARD });
          return;
        }
        ctx.session.botToken = text;
        ctx.session.step = "awaiting_catalog";
        await ctx.reply(
          `✅ Bot: <b>${sanitize(d.result?.first_name ?? "")} (@${sanitize(d.result?.username ?? "")})</b>\n\n` +
          `<b>3-qadam / 3:</b> Mahsulotlar katalogini yuboring:\n\n` +
          `<code>Mahsulot nomi | Narxi | Tavsifi\nMahsulot nomi | Narxi | Tavsifi</code>\n\n` +
          `<b>Namuna:</b>\n<code>iPhone 15 Pro | 12 500 000 so'm | 256GB, kafolat\nAirPods Pro | 2 800 000 so'm | USB-C, original</code>`,
          { parse_mode: "HTML", reply_markup: CANCEL_KEYBOARD }
        );
      } catch (err) {
        logger.error({ err }, "Token validation error");
        await ctx.reply("❌ Server xatosi. Qayta yuboring:", { reply_markup: CANCEL_KEYBOARD });
      }
      return;
    }

    // ── Step 3: catalog (new store) ──────────────────────────────────────
    if (step === "awaiting_catalog") {
      const { isValid, formatted, preview } = parseCatalog(text);
      if (!isValid) {
        await ctx.reply(
          `❌ <b>Format xatosi:</b>\n\n${sanitize(preview)}\n\nFormat: <code>Nomi | Narxi | Tavsifi</code>`,
          { parse_mode: "HTML", reply_markup: CANCEL_KEYBOARD }
        );
        return;
      }

      const tgId = BigInt(ctx.from!.id);
      const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, tgId) });
      const savedToken = ctx.session.botToken;
      const savedName = ctx.session.storeName;

      if (!user || !savedToken || !savedName) {
        await ctx.reply("❌ Sessiya xatosi. Qaytadan boshlang.", { reply_markup: { remove_keyboard: true } });
        ctx.session.step = undefined;
        return;
      }

      const r = await fetch(`https://api.telegram.org/bot${savedToken}/getMe`);
      const d = await r.json() as { ok: boolean; result?: { username?: string } };
      if (!d.ok) {
        await ctx.reply("❌ Token endi yaroqsiz. Qaytadan boshlang.", { reply_markup: { remove_keyboard: true } });
        ctx.session.step = undefined;
        return;
      }

      const botUsername = d.result?.username ?? "unknown";
      const serverUrl = getServerUrl();

      await db.insert(storesTable).values({
        ownerId: user.id, botToken: savedToken, botUsername,
        storeName: savedName, contextData: formatted, isActive: true,
      });

      if (serverUrl) {
        const webhookUrl = `${serverUrl}/api/webhook/store/${savedToken}`;
        await fetch(`https://api.telegram.org/bot${savedToken}/setWebhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
        });
        logger.info({ storeName: savedName, webhookUrl }, "Store webhook registered");
      }

      ctx.session.step = undefined;
      ctx.session.storeName = undefined;
      ctx.session.botToken = undefined;

      await ctx.reply(
        `🎉 <b>Do'kon yaratildi!</b>\n\n🏪 ${sanitize(savedName)}\n🤖 @${sanitize(botUsername)}\n\n` +
        `<b>Katalog (${formatted.split("\n").length} ta mahsulot):</b>\n${preview}\n\n` +
        `🔗 https://t.me/${sanitize(botUsername)}`,
        { parse_mode: "HTML", reply_markup: { remove_keyboard: true } }
      );
      await ctx.reply("Bo'limni tanlang:", { reply_markup: START_KEYBOARD });
      return;
    }

    // ── Editing catalog for existing store ───────────────────────────────
    if (step === "editing_catalog") {
      const storeId = ctx.session.editingStoreId;
      if (!storeId) {
        ctx.session.step = undefined;
        await ctx.reply("❌ Sessiya xatosi. Qaytadan urinib ko'ring.");
        return;
      }

      const { isValid, formatted, preview } = parseCatalog(text);
      if (!isValid) {
        await ctx.reply(
          `❌ <b>Format xatosi:</b>\n\n${sanitize(preview)}\n\nFormat: <code>Nomi | Narxi | Tavsifi</code>`,
          { parse_mode: "HTML", reply_markup: CANCEL_KEYBOARD }
        );
        return;
      }

      await db.update(storesTable)
        .set({ contextData: formatted })
        .where(eq(storesTable.id, storeId));

      ctx.session.step = undefined;
      ctx.session.editingStoreId = undefined;

      logger.info({ storeId }, "Store catalog updated");
      await ctx.reply(
        `✅ <b>Katalog yangilandi!</b>\n\n${preview}`,
        { parse_mode: "HTML", reply_markup: { remove_keyboard: true } }
      );
      await ctx.reply("Bo'limni tanlang:", { reply_markup: START_KEYBOARD });
    }
  });

  return bot;
}
