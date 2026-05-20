import app from "./app";
import { logger } from "./lib/logger";
import { webhookCallback } from "grammy";
import { createPlatformBot } from "./bot/platformBot";
import { setPlatformBotHandler } from "./routes";
import type { Request, Response } from "express";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  const platformToken = process.env.PLATFORM_BOT_TOKEN;
  if (!platformToken) {
    logger.warn("PLATFORM_BOT_TOKEN not set — platform bot disabled");
    return;
  }

  try {
    const bot = createPlatformBot(platformToken);

    const handler = webhookCallback(bot, "express");
    setPlatformBotHandler(handler as (req: Request, res: Response) => Promise<void>);

    const domain = process.env.REPLIT_DEV_DOMAIN;
    if (domain) {
      const webhookUrl = `https://${domain}/api/webhook/platform`;
      const res = await fetch(`https://api.telegram.org/bot${platformToken}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl }),
      });
      const data = await res.json() as { ok: boolean; description?: string };
      if (data.ok) {
        logger.info({ webhookUrl }, "Platform bot webhook registered");
      } else {
        logger.error({ data }, "Failed to register platform bot webhook");
      }
    } else {
      logger.warn("REPLIT_DEV_DOMAIN not set — webhook not registered");
    }
  } catch (err) {
    logger.error({ err }, "Failed to initialize platform bot");
  }
});
