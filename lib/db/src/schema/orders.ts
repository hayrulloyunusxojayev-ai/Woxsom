import { pgTable, uuid, bigint, text, jsonb, numeric, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { storesTable } from "./stores";

export const ordersTable = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull().references(() => storesTable.id),
    customerTgId: bigint("customer_tg_id", { mode: "bigint" }).notNull(),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    customerAddress: text("customer_address").notNull(),
    orderItems: jsonb("order_items").notNull(),
    totalPrice: numeric("total_price", { precision: 12, scale: 2 }).notNull().default("0"),
    status: text("status").notNull().default("PENDING"),
    source: text("source").notNull().default("TELEGRAM"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("orders_store_id_idx").on(t.storeId),
    index("orders_created_at_idx").on(t.createdAt),
    index("orders_store_created_idx").on(t.storeId, t.createdAt),
  ],
);

export const insertOrderSchema = createInsertSchema(ordersTable).omit({ id: true, createdAt: true });
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof ordersTable.$inferSelect;
