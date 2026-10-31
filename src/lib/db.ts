import { Pool } from "pg";

type DbGlobal = typeof globalThis & { caloriePool?: Pool };
const dbGlobal = globalThis as DbGlobal;

export function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (!dbGlobal.caloriePool) {
    dbGlobal.caloriePool = new Pool({
      connectionString,
      ssl: connectionString.includes("localhost")
        ? undefined
        : { rejectUnauthorized: true },
      max: 5,
      connectionTimeoutMillis: 4000,
      statement_timeout: 5000,
      query_timeout: 6000,
    });
    // Pool-level connection failures must not expose the connection string.
    dbGlobal.caloriePool.on("error", () => {
      console.error(
        JSON.stringify({
          event: "database_pool_error",
          errorCode: "DATABASE_UNAVAILABLE",
        }),
      );
    });
  }
  return dbGlobal.caloriePool;
}
