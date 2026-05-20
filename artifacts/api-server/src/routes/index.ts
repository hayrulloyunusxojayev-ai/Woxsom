import { Router, type IRouter } from "express";
import healthRouter from "./health";
import webhookStoreRouter from "./webhookStore";
import webhookPlatformRouter, { setPlatformBotHandler } from "./webhookPlatform";
import webhookInstagramRouter from "./webhookInstagram";

export { setPlatformBotHandler };

const router: IRouter = Router();

router.use(healthRouter);
router.use(webhookStoreRouter);
router.use(webhookPlatformRouter);
router.use(webhookInstagramRouter);

export default router;
