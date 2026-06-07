import app from "./app";
import { logger } from "./lib/logger";
import { webhookCallback } from "grammy";
import { createPlatformBot } from "./bot/platformBot";
import { setPlatformBotHandler } from "./routes";
import { db, pool } from "@workspace/db";
import { storesTable } from "@workspace/db";
import { eq, isNotNull } from "drizzle-orm";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Global error guards — must be registered before anything else runs.
// These prevent the process from exiting on an unhandled rejection or
// uncaught exception thrown in a callback/promise that has no local handler.
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise: String(promise) }, "Unhandled promise rejection");
  // Do NOT call process.exit() here — let the process keep serving requests.
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — process will continue");
  // Only fatal errors (EADDRINUSE, OOM, etc.) should kill the process.
  // For recoverable errors (e.g. a bad JSON parse in a third-party lib),
  // logging and continuing is safer than crashing 1 000 active connections.
});

// Pool-level idle-client errors (e.g. PG server closed the socket) are
// already handled in lib/db/src/index.ts, but re-register here as a safety net.
pool.on("error", (err) => {
  logger.error({ err }, "DB pool idle client error (index.ts)");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

function getServerUrl(): string | null {
  if (process.env.SERVER_URL) return process.env.SERVER_URL.replace(/\/$/, "");
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return null;
}

async function registerWebhook(token: string, url: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, drop_pending_updates: true }),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    return data.ok;
  } catch {
    return false;
  }
}

async function bootstrapStoreWebhooks(serverUrl: string): Promise<void> {
  try {
    const activeStores = await db
      .select({
        id: storesTable.id,
        botToken: storesTable.botToken,
        storeName: storesTable.storeName,
      })
      .from(storesTable)
      .where(eq(storesTable.isActive, true));

    if (activeStores.length === 0) {
      logger.info("No active stores found — skipping store webhook bootstrap");
      return;
    }

    logger.info({ count: activeStores.length }, "Bootstrapping store webhooks");

    const results = await Promise.allSettled(
      activeStores.map(async (store) => {
        const webhookUrl = `${serverUrl}/api/webhook/store/${store.botToken}`;
        const ok = await registerWebhook(store.botToken, webhookUrl);
        if (ok) {
          logger.info({ storeName: store.storeName, webhookUrl }, "Store webhook registered");
        } else {
          logger.warn({ storeName: store.storeName, webhookUrl }, "Store webhook registration failed");
        }
        return { store: store.storeName, ok };
      }),
    );

    const succeeded = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok,
    ).length;
    const failed = activeStores.length - succeeded;
    logger.info({ succeeded, failed }, "Store webhook bootstrap complete");
  } catch (err) {
    logger.error({ err }, "Failed to bootstrap store webhooks");
  }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  const serverUrl = getServerUrl();
  if (!serverUrl) {
    logger.warn("Neither SERVER_URL nor REPLIT_DEV_DOMAIN is set — webhooks not registered");
    return;
  }

  const platformToken = process.env.PLATFORM_BOT_TOKEN;
  if (!platformToken) {
    logger.warn("PLATFORM_BOT_TOKEN not set — platform bot disabled");
  } else {
    try {
      const bot = createPlatformBot(platformToken);
      const handler = webhookCallback(bot, "express");
      setPlatformBotHandler(handler as (req: Request, res: Response) => Promise<void>);

      const platformWebhookUrl = `${serverUrl}/api/webhook/platform`;
      const ok = await registerWebhook(platformToken, platformWebhookUrl);
      if (ok) {
        logger.info({ webhookUrl: platformWebhookUrl }, "Platform bot webhook registered");
      } else {
        logger.error({ platformWebhookUrl }, "Failed to register platform bot webhook");
      }
    } catch (err) {
      logger.error({ err }, "Failed to initialize platform bot");
    }
  }

  await bootstrapStoreWebhooks(serverUrl);
  // Instagram page subscription is configured manually in the Meta Developer Dashboard.
  // await subscribeInstagramPageWebhooks();
});

// ---------------------------------------------------------------------------
// Instagram webhook subscription helper (kept but not auto-called on boot)
// ---------------------------------------------------------------------------
async function subscribeInstagramPageWebhooks(): Promise<void> {
  const globalToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  const pages = new Map<string, string>();

  try {
    const stores = await db
      .select({
        instagramPageId: storesTable.instagramPageId,
        instagramToken: storesTable.instagramToken,
      })
      .from(storesTable)
      .where(isNotNull(storesTable.instagramPageId));

    for (const s of stores) {
      if (!s.instagramPageId) continue;
      const token = s.instagramToken ?? globalToken;
      if (token) pages.set(s.instagramPageId, token);
      else logger.warn({ pageId: s.instagramPageId }, "Instagram page skipped — no token");
    }
  } catch (err) {
    logger.error({ err }, "Failed to query Instagram page IDs");
  }

  const envPageId = process.env.INSTAGRAM_PAGE_ID;
  if (envPageId && globalToken && !pages.has(envPageId)) {
    pages.set(envPageId, globalToken);
  }

  if (pages.size === 0) {
    logger.info("No Instagram pages with valid tokens — skipping subscription");
    return;
  }

  for (const [pageId, accessToken] of pages) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v25.0/${pageId}/subscribed_apps`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscribed_fields: "messages", access_token: accessToken }),
        },
      );
      const data = (await res.json()) as {
        success?: boolean;
        error?: { message: string };
      };
      if (data.success) {
        logger.info({ pageId }, "Instagram page subscribed");
      } else {
        logger.error({ pageId, error: data.error?.message }, "Instagram subscription failed");
      }
    } catch (err) {
      logger.error({ err, pageId }, "Instagram subscription network error");
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
void subscribeInstagramPageWebhooks; // keep reference to silence tree-shaker
