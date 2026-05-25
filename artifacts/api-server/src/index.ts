import app from "./app";
import { logger } from "./lib/logger";
import { webhookCallback } from "grammy";
import { createPlatformBot } from "./bot/platformBot";
import { setPlatformBotHandler } from "./routes";
import { db } from "@workspace/db";
import { storesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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
});
