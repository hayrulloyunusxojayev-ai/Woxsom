/**
 * Rate-limited Telegram Bot API client.
 *
 * Features:
 * - Per-chat send rate enforcement (600 ms min gap) to stay under
 *   Telegram's ~1 msg/sec per chat limit and avoid 429 errors.
 * - Automatic 429 retry: reads `retry_after` from Telegram's response
 *   and sleeps exactly that long before retrying.
 * - Per-request timeout (8 s) with AbortController so stalled network
 *   calls don't hold an event-loop slot forever.
 * - Stale rate-limit entries are cleaned up every 10 minutes so the
 *   Map doesn't grow unboundedly across long uptime.
 */

import { logger } from "./logger";

const TG_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 8_000;
const CHAT_MIN_GAP_MS = 600;   // Conservative: Telegram allows 1 msg/sec per chat
const MAX_RETRIES = 3;

export type InlineKeyboard = { text: string; callback_data: string }[][];

// ── Rate-limit state ────────────────────────────────────────────────────────
// key = `${botToken}:${chatId}`, value = last-send timestamp
const chatLastSent = new Map<string, number>();

// Clean up entries older than 1 minute every 10 minutes.
// `.unref()` ensures this timer doesn't keep the process alive.
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, ts] of chatLastSent) {
    if (ts < cutoff) chatLastSent.delete(key);
  }
}, 10 * 60_000).unref();

// ── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Core request with retry ──────────────────────────────────────────────────
async function tgRequest(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = `${TG_BASE}/bot${botToken}/${method}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Telegram rate limit — back off and retry
      if (res.status === 429) {
        const data = (await res.json()) as { parameters?: { retry_after?: number } };
        const retryAfterMs = (data.parameters?.retry_after ?? 5) * 1_000;
        logger.warn({ method, retryAfterMs, attempt }, "Telegram 429 — backing off");
        await sleep(retryAfterMs);
        continue;
      }

      const data = await res.json();
      if (!res.ok) {
        logger.warn({ method, status: res.status, data }, "Telegram API non-OK response");
      }
      return data;
    } catch (err: unknown) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        logger.warn({ method, attempt }, "Telegram request timed out — retrying");
        // Timeout: retry immediately (already waited REQUEST_TIMEOUT_MS)
        continue;
      }
      // Network-level error: bubble up so caller's try/catch handles it
      throw err;
    }
  }

  logger.error({ method }, "Telegram request failed after max retries");
  // Don't throw — silently fail so one bad Telegram send doesn't crash the webhook handler
  return null;
}

// ── Per-chat rate-limited send ───────────────────────────────────────────────
async function enforcePerChatGap(botToken: string, chatId: number | bigint): Promise<void> {
  const key = `${botToken}:${chatId}`;
  const now = Date.now();
  const last = chatLastSent.get(key) ?? 0;
  const wait = CHAT_MIN_GAP_MS - (now - last);
  if (wait > 0) await sleep(wait);
  chatLastSent.set(key, Date.now());
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function tgSend(
  botToken: string,
  chatId: number | bigint,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await enforcePerChatGap(botToken, chatId);
  const payload: Record<string, unknown> = {
    chat_id: Number(chatId),
    text: text.slice(0, 4_096),
    parse_mode: "HTML",
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  await tgRequest(botToken, "sendMessage", payload);
}

export async function tgSendPhoto(
  botToken: string,
  chatId: number | bigint,
  photo: string,
  caption: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await enforcePerChatGap(botToken, chatId);
  const payload: Record<string, unknown> = {
    chat_id: Number(chatId),
    photo,
    caption: caption.slice(0, 1_024),
    parse_mode: "HTML",
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  await tgRequest(botToken, "sendPhoto", payload);
}

export async function tgAnswer(
  botToken: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  // answerCallbackQuery is not a chat message — no rate-limit enforcement needed
  await tgRequest(botToken, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}
