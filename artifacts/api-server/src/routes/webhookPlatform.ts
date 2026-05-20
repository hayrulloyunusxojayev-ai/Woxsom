import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger";

const router = Router();

let platformBotHandler: ((req: Request, res: Response) => Promise<void>) | null = null;

export function setPlatformBotHandler(handler: (req: Request, res: Response) => Promise<void>) {
  platformBotHandler = handler;
}

router.post("/webhook/platform", async (req, res) => {
  if (!platformBotHandler) {
    res.sendStatus(200);
    return;
  }
  try {
    await platformBotHandler(req, res);
  } catch (err) {
    logger.error({ err }, "Error in platform webhook");
    res.sendStatus(200);
  }
});

export default router;
