# Woxsom AI

A Telegram Bot Constructor platform with built-in AI Employees for micro-businesses in Uzbekistan. Store owners create AI-powered shop bots that autonomously converse in Uzbek/Russian and collect orders.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `PLATFORM_BOT_TOKEN` — Telegram bot token for the main constructor bot
- Auto-set: `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY` — Replit AI proxy

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Telegram Bot: grammy (externalized from esbuild bundle)
- AI: Replit AI Integrations → OpenAI proxy (gpt-5-mini)
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (ESM bundle)

## Where things live

- `lib/db/src/schema/` — DB schema (users.ts, stores.ts, orders.ts)
- `artifacts/api-server/src/bot/platformBot.ts` — Constructor bot (Uzbek UI, session wizard)
- `artifacts/api-server/src/routes/webhookStore.ts` — AI store bot webhook handler
- `artifacts/api-server/src/routes/webhookPlatform.ts` — Platform bot webhook receiver
- `artifacts/api-server/src/index.ts` — Server entry point + auto webhook registration
- `lib/integrations-openai-ai-server/` — Replit OpenAI proxy client

## Architecture decisions

- grammy is externalized from the esbuild bundle (`external: ["grammy"]`) because it loads native `.node` binaries via relative CJS requires which break when bundled.
- Platform bot webhook is registered on every server start — idempotent, Telegram deduplicates.
- Store bot webhooks are registered per-token at `POST /api/webhook/store/:bot_token` — the Express route handles all store bots dynamically from DB lookup.
- AI order detection uses a plain text marker `___CREATE_ORDER___` appended to AI responses to avoid JSON parsing ambiguity with conversational text.
- All Telegram `sendMessage` calls are wrapped in try/catch to prevent webhook response failures from breaking the bot.

## Product

- **Constructor Bot**: Store owners chat with the platform bot in Uzbek to create their shop bots via a 3-step wizard (name → token validation → catalog).
- **AI Store Bot**: Each shop gets its own Telegram bot powered by an AI employee that knows the catalog, sells in Uzbek/Russian, and collects customer orders (name, phone, address).
- **Order Notifications**: When an order is complete, the store owner gets a rich notification via the platform bot.
- **My Stores / Orders**: Owners can view all their stores and recent orders directly in the constructor bot.

## User preferences

- 100% Uzbek language interface for the constructor bot
- Store AI responds in Uzbek by default, switches to Russian if customer uses Russian

## Gotchas

- Always run `pnpm --filter @workspace/db run push` after schema changes before restarting the server.
- grammy MUST remain in the `external` list in `artifacts/api-server/build.mjs` — removing it will crash the server with a native module error.
- `REPLIT_DEV_DOMAIN` is auto-provided by Replit and used for webhook URL construction.
- Use `pnpm --filter @workspace/api-server run typecheck` (not `build`) to verify TS without needing PORT/BASE_PATH env vars.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
