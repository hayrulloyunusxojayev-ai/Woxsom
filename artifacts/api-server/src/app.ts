import express, { type Express, type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// --- Логирование ---
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


app.get("/", (_req, res) => {
  res.json({ status: "Woxsom AI Server Backend Live" });
});


app.use("/api", router);

// --- FRONTEND (Раздача статики из mockup-sandbox) ---
// В твоей структуре: из artifacts/api-server/src нужно подняться на 3 уровня, 
// чтобы попасть в корень, а затем войти в mockup-sandbox/dist
const frontendPath = path.resolve(__dirname, "../../../mockup-sandbox/dist");

// Раздаём статические файлы (JS, CSS, картинки)
app.use(express.static(frontendPath));

// --- SPA fallback ---
app.use((req: Request, res: Response, next: NextFunction) => {
  // Пропускаем, если это не GET запрос или если это запрос к API
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api")) return next();

  // Отдаем index.html для всех остальных маршрутов (чтобы работал React Router)
  res.sendFile(path.join(frontendPath, "index.html"));
});

export default app;
