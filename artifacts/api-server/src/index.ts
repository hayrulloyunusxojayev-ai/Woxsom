import app from "./app";
import { logger } from "./lib/logger";
import { webhookCallback } from "grammy";
import { createPlatformBot } from "./bot/platformBot";
import { setPlatformBotHandler } from "./routes";
import { db } from "@workspace/db";
import { storesTable } from "@workspace/db";
import { eq, isNotNull } from "drizzle-orm";
import type { Request, Response } from "express";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

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
    const data = await res.json() as { ok: boolean; description?: string };
    return data.ok;
  } catch {
    return false;
  }
}

async function bootstrapStoreWebhooks(serverUrl: string): Promise<void> {
  try {
    const activeStores = await db
      .select({ id: storesTable.id, botToken: storesTable.botToken, storeName: storesTable.storeName })
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
      })
    );

    const succeeded = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
    const failed = activeStores.length - succeeded;
    logger.info({ succeeded, failed }, "Store webhook bootstrap complete");
  } catch (err) {
    logger.error({ err }, "Failed to bootstrap store webhooks");
  }
}

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
  await subscribeInstagramPageWebhooks();
});

async function subscribeInstagramPageWebhooks(): Promise<void> {
  const accessToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  if (!accessToken) {
    console.log("[Instagram] INSTAGRAM_PAGE_ACCESS_TOKEN not set — skipping page subscription");
    return;
  }

  // Collect all unique Instagram Page IDs from active stores, plus any env-level default
  const pageIds = new Set<string>();

  try {
    const stores = await db
      .select({ instagramPageId: storesTable.instagramPageId, instagramToken: storesTable.instagramToken })
      .from(storesTable)
      .where(isNotNull(storesTable.instagramPageId));
    for (const s of stores) {
      if (s.instagramPageId) pageIds.add(s.instagramPageId);
    }
  } catch (err) {
    console.error("[Instagram] Failed to query store page IDs:", err);
  }

  // Fallback: hardcoded env var page ID if no DB rows found
  const envPageId = process.env.INSTAGRAM_PAGE_ID;
  if (envPageId) pageIds.add(envPageId);

  if (pageIds.size === 0) {
    console.log("[Instagram] No Instagram Page IDs found — skipping subscription");
    return;
  }

  const subscribedFields = "messages,messaging_postbacks,messaging_seen";

  for (const pageId of pageIds) {
    try {
      const url = `https://graph.facebook.com/v25.0/${pageId}/subscribed_apps`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscribed_fields: subscribedFields, access_token: accessToken }),
      });
      const data = await res.json() as { success?: boolean; error?: { message: string } };
      if (data.success) {
        console.log(`[Instagram] ✅ Page ${pageId} subscribed to fields: ${subscribedFields}`);
        logger.info({ pageId, subscribedFields }, "Instagram page subscription active");
      } else {
        console.error(`[Instagram] ❌ Page ${pageId} subscription failed:`, data.error?.message ?? JSON.stringify(data));
        logger.error({ pageId, data }, "Instagram page subscription failed");
      }
    } catch (err) {
      console.error(`[Instagram] ❌ Network error subscribing page ${pageId}:`, err);
      logger.error({ err, pageId }, "Instagram page subscription network error");
    }
  }
}
