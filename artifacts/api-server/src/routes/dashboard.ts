import { Router } from "express";
import { db } from "@workspace/db";
import { storesTable, ordersTable } from "@workspace/db";
import { count, eq, sql } from "drizzle-orm";
import { GetDashboardStatsResponse, ListStoresResponse, ListOrdersResponse } from "@workspace/api-zod";

const router = Router();

router.get("/dashboard/stats", async (req, res) => {
  try {
    const [storeStats] = await db
      .select({
        total: count(),
        active: sql<number>`cast(sum(case when ${storesTable.isActive} then 1 else 0 end) as int)`,
      })
      .from(storesTable);

    const [orderStats] = await db
      .select({
        total: count(),
        today: sql<number>`cast(sum(case when ${ordersTable.createdAt} >= current_date then 1 else 0 end) as int)`,
      })
      .from(ordersTable);

    const payload = {
      activeStores: storeStats?.active ?? 0,
      totalStores: storeStats?.total ?? 0,
      totalLeads: orderStats?.total ?? 0,
      messagesToday: orderStats?.today ?? 0,
    };

    const parsed = GetDashboardStatsResponse.parse(payload);
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "Failed to get dashboard stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/dashboard/stores", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: storesTable.id,
        storeName: storesTable.storeName,
        botUsername: storesTable.botUsername,
        isActive: storesTable.isActive,
        createdAt: storesTable.createdAt,
        orderCount: sql<number>`cast(count(${ordersTable.id}) as int)`,
      })
      .from(storesTable)
      .leftJoin(ordersTable, eq(ordersTable.storeId, storesTable.id))
      .groupBy(storesTable.id)
      .orderBy(sql`${storesTable.createdAt} desc`)
      .limit(50);

    const payload = rows.map((r) => ({
      id: r.id,
      storeName: r.storeName,
      botUsername: r.botUsername,
      isActive: r.isActive,
      source: "TELEGRAM",
      orderCount: r.orderCount ?? 0,
      createdAt: r.createdAt.toISOString(),
    }));

    const parsed = ListStoresResponse.parse(payload);
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "Failed to list stores");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/dashboard/orders", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: ordersTable.id,
        storeName: storesTable.storeName,
        customerName: ordersTable.customerName,
        customerPhone: ordersTable.customerPhone,
        customerAddress: ordersTable.customerAddress,
        totalPrice: ordersTable.totalPrice,
        status: ordersTable.status,
        source: ordersTable.source,
        createdAt: ordersTable.createdAt,
      })
      .from(ordersTable)
      .innerJoin(storesTable, eq(storesTable.id, ordersTable.storeId))
      .orderBy(sql`${ordersTable.createdAt} desc`)
      .limit(50);

    const payload = rows.map((r) => ({
      id: r.id,
      storeName: r.storeName,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      customerAddress: r.customerAddress ?? undefined,
      totalPrice: r.totalPrice ?? "0",
      status: r.status,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    }));

    const parsed = ListOrdersResponse.parse(payload);
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "Failed to list orders");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
