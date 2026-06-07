import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Tune for ~1000 concurrent users across multiple bot webhooks
  max: 20,                    // max concurrent DB connections
  min: 2,                     // keep 2 warm connections alive
  idleTimeoutMillis: 30_000,  // release idle connections after 30s
  connectionTimeoutMillis: 5_000, // fail fast if pool is exhausted
});

// Prevent an idle connection error from crashing the process
pool.on("error", (err) => {
  console.error("[DB Pool] Unexpected idle client error:", err.message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
