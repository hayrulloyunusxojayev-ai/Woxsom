import express, { type Express, type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// --- Logging ---
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- API routes ---
app.use("/api", router);

// --- Frontend static files ---
// In production (Render), the dashboard is built and served from here.
// In dev (Replit), this path won't exist — the Vite dev server handles it separately.
// __dirname in the built output = artifacts/api-server/dist/
const frontendDist = path.resolve(__dirname, "../../dashboard/dist/public");
const frontendExists = fs.existsSync(frontendDist);

if (frontendExists) {
  app.use(express.static(frontendDist));

  // SPA fallback: all non-API GET routes serve index.html so React Router works
  // Express 5 requires a named wildcard parameter (not bare *)
  app.get("/{*splat}", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(frontendDist, "index.html"), (err) => {
      if (err) next();
    });
  });
} else {
  // Dev-only health root so the API server isn't completely silent at /
  app.get("/", (_req, res) => {
    res.json({ status: "Woxsom AI API running (dev mode — frontend served separately)" });
  });
}

export default app;
