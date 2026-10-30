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
    });
  }
  return dbGlobal.caloriePool;
}
