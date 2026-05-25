import { pgTable, uuid, bigint, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const storesTable = pgTable("stores", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => usersTable.id),
  botToken: text("bot_token").notNull().unique(),
  botUsername: text("bot_username").notNull(),
  storeName: text("store_name").notNull(),
  contextData: text("context_data").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  instagramPageId: text("instagram_page_id").unique(),
  instagramToken: text("instagram_token"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertStoreSchema = createInsertSchema(storesTable).omit({ id: true, createdAt: true });
export type InsertStore = z.infer<typeof insertStoreSchema>;
export type Store = typeof storesTable.$inferSelect;
