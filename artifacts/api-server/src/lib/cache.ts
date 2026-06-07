/**
 * In-process LRU cache with TTL — no external dependencies.
 *
 * Uses JavaScript Map insertion-order to implement O(1) LRU eviction:
 * - get()  → moves entry to tail (most-recently-used)
 * - set()  → inserts at tail; evicts head when full
 */
class LRUCache<K, V> {
  private map = new Map<K, { value: V; expiresAt: number }>();

  constructor(private readonly maxSize: number, private readonly ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Promote to MRU position
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Returns true if the key exists and has not expired. */
  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict LRU (head of Map)
      const lruKey = this.map.keys().next().value as K;
      this.map.delete(lruKey);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Store config cache
// Keyed by bot_token. TTL = 5 minutes. Max 200 active stores.
// `null` means "token exists in DB but store is inactive/not found" —
// also cached to avoid hammering the DB on dead/spam tokens.
// ---------------------------------------------------------------------------
import { db } from "@workspace/db";
import { storesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

type Store = typeof storesTable.$inferSelect;

const storeCache = new LRUCache<string, Store | null>(200, 5 * 60_000);

export async function getStoreByToken(token: string): Promise<Store | null> {
  const cached = storeCache.get(token);
  // `undefined`  = not in cache at all → must query
  // `null`       = cached "not found"  → return null without querying
  // `Store`      = cached hit          → return immediately
  if (cached !== undefined) return cached;
  const store =
    (await db.query.storesTable.findFirst({ where: eq(storesTable.botToken, token) })) ?? null;
  storeCache.set(token, store);
  return store;
}

/** Call after any store update or delete to force the next request to re-fetch. */
export function invalidateStore(token: string): void {
  storeCache.delete(token);
}

// ---------------------------------------------------------------------------
// Conversation history cache
// Keyed by `${botToken}:${chatId}`.
// TTL = 1 hour (auto-evict silent chats). Max 500 concurrent conversations.
// Capped at 10 messages per chat to bound per-entry memory.
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const MAX_HISTORY_PER_CHAT = 10;
const historyCache = new LRUCache<string, ChatMessage[]>(500, 60 * 60_000);

function hKey(botToken: string, chatId: number): string {
  return `${botToken}:${chatId}`;
}

export function getHistory(botToken: string, chatId: number): ChatMessage[] {
  const key = hKey(botToken, chatId);
  const existing = historyCache.get(key);
  if (existing) return existing;
  const fresh: ChatMessage[] = [];
  historyCache.set(key, fresh);
  return fresh;
}

export function appendHistory(
  botToken: string,
  chatId: number,
  role: "user" | "assistant",
  content: string,
): void {
  const history = getHistory(botToken, chatId);
  history.push({ role, content });
  // Keep only the latest N messages — trim from the front
  if (history.length > MAX_HISTORY_PER_CHAT) {
    history.splice(0, history.length - MAX_HISTORY_PER_CHAT);
  }
  // Re-set to refresh TTL and promote to MRU
  historyCache.set(hKey(botToken, chatId), history);
}

export function clearHistory(botToken: string, chatId: number): void {
  historyCache.delete(hKey(botToken, chatId));
}

// ---------------------------------------------------------------------------
// Per-user request debounce
// Prevents a single user from queuing up many concurrent AI calls.
// One active AI request per chatId at a time.
// ---------------------------------------------------------------------------
const activeRequests = new Set<string>();

export function tryLockChat(botToken: string, chatId: number): boolean {
  const key = hKey(botToken, chatId);
  if (activeRequests.has(key)) return false;
  activeRequests.add(key);
  return true;
}

export function unlockChat(botToken: string, chatId: number): void {
  activeRequests.delete(hKey(botToken, chatId));
}
