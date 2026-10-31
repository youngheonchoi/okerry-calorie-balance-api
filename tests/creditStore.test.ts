import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPgCreditStore } from "../src/lib/creditStore";
import { createCalorieEstimator } from "../src/lib/openaiCalories";
import { createCalorieService } from "../src/lib/calorieService";

const databases: PGlite[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});
async function setup() {
  const db = new PGlite();
  databases.push(db);
  await db.exec(
    await readFile(
      new URL("../database/calorie-credits.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.exec(
    'CREATE TABLE foods (id BIGINT GENERATED ALWAYS AS IDENTITY, food_name TEXT COLLATE "C", calories_kcal NUMERIC(10,2))',
  );
  // PGlite has one connection: serialize transactions, like a one-client pg Pool.
  // SQL executes in PostgreSQL; this does not emulate production multi-client locks.
  let queue: Promise<void> = Promise.resolve();
  async function acquire() {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
  const store = createPgCreditStore({
    connect: async () => {
      const release = await acquire();
      return {
        query: (sql: string, values?: unknown[]) => db.query(sql, values),
        release,
      } as unknown as PoolClient;
    },
    query: async (sql, values) => {
      const release = await acquire();
      try {
        return await db.query<Record<string, unknown>>(sql, values);
      } finally {
        release();
      }
    },
  });
  async function grant(user = "user") {
    const event = await store.prepareReward(user);
    await store.completeReward(user, event.eventId);
    return event.eventId;
  }
  return { db, store, grant };
}
describe("PostgreSQL credit transactions", () => {
  it.each([0, 95])(
    "returns zero and spends exactly once for recognized:false (provider kcal %s)",
    async (providerCalories) => {
      const { store, grant } = await setup();
      await grant();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              status: "completed",
              output: [
                {
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({
                        recognized: false,
                        calories_kcal: providerCalories,
                      }),
                    },
                  ],
                },
              ],
            }),
          ),
      );
      const calculate = createCalorieService(
        store,
        createCalorieEstimator({ apiKey: "test-only-key", fetcher }),
      );
      const id = randomUUID();
      const result = await calculate("user", id, "???");
      expect(result).toMatchObject({
        remainingCount: 4,
        reservedCount: 0,
        result: { caloriesKcal: 0, source: "ai" },
      });
      expect(await calculate("user", id, "???")).toEqual(result);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(await store.status("user")).toEqual({
        remainingCount: 4,
        reservedCount: 0,
      });
    },
  );

  it("grants five only at zero and makes duplicate completions idempotent", async () => {
    const { store, grant } = await setup();
    const id = await grant();
    await expect(store.completeReward("user", id)).resolves.toEqual({
      remainingCount: 5,
      reservedCount: 0,
    });
    await expect(store.prepareReward("user")).rejects.toMatchObject({
      code: "CREDITS_REMAINING",
    });
    await expect(store.completeReward("other-user", id)).rejects.toMatchObject({
      code: "REQUEST_CONFLICT",
    });
    expect(await store.status("other-user")).toEqual({
      remainingCount: 0,
      reservedCount: 0,
    });
  });
  it("reuses one pending reward session and never grants after cancellation", async () => {
    const { store } = await setup();
    const [first, second] = await Promise.all([
      store.prepareReward("user"),
      store.prepareReward("user"),
    ]);
    expect(first.eventId).toBe(second.eventId);
    await store.cancelReward("user", first.eventId);
    await expect(
      store.completeReward("user", first.eventId),
    ).rejects.toMatchObject({ code: "REWARD_EXPIRED" });
    expect((await store.status("user")).remainingCount).toBe(0);
  });
  it("allows only five of six overlapping calculations to reserve credits", async () => {
    const { store, grant } = await setup();
    await grant();
    let finish!: (value: number) => void;
    const waiting = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const estimate = vi.fn(() => waiting);
    const calculate = createCalorieService(store, estimate);
    const requests = Array.from({ length: 6 }, () =>
      calculate("user", randomUUID(), "Apple"),
    );
    // Attach handlers before rejection to avoid unhandled-rejection noise.
    const settled = Promise.allSettled(requests);
    await vi.waitFor(() => expect(estimate).toHaveBeenCalledTimes(5));
    expect(await store.status("user")).toEqual({
      remainingCount: 5,
      reservedCount: 5,
    });
    finish(95);
    const results = await settled;
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(5);
    expect(await store.status("user")).toEqual({
      remainingCount: 0,
      reservedCount: 0,
    });
  });
  it("replays a completed last credit without another debit or AI call", async () => {
    const { db, store, grant } = await setup();
    await grant();
    await db.exec("UPDATE user_calorie_credits SET remaining_count=1");
    const estimate = vi.fn(async () => 95),
      id = randomUUID();
    const calculate = createCalorieService(store, estimate);
    const first = await calculate("user", id, "Apple"),
      replay = await calculate("user", id, "Apple");
    expect(replay).toEqual(first);
    expect(replay.remainingCount).toBe(0);
    expect(estimate).toHaveBeenCalledOnce();
    await expect(calculate("other-user", id, "Apple")).rejects.toMatchObject({
      code: "REQUEST_CONFLICT",
    });
    await expect(calculate("user", id, "apple")).rejects.toMatchObject({
      code: "REQUEST_CONFLICT",
    });
  });
  it("releases failures and expired reservations without decreasing balance", async () => {
    const { db, store, grant } = await setup();
    await grant();
    const id = randomUUID();
    await store.reserve("user", id, "Apple");
    await store.fail("user", id);
    expect(await store.status("user")).toEqual({
      remainingCount: 5,
      reservedCount: 0,
    });
    const expired = randomUUID();
    await store.reserve("user", expired, "Apple");
    await db.query(
      "UPDATE calorie_credit_history SET reserved_until=now()-interval '1 second' WHERE id=$1",
      [expired],
    );
    expect(await store.status("user")).toEqual({
      remainingCount: 5,
      reservedCount: 0,
    });
    await expect(
      store.succeed("user", expired, {
        foodName: "Apple",
        caloriesKcal: 95,
        source: "ai",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    expect((await store.status("user")).remainingCount).toBe(5);
  });
  it("selects the first ID and treats case and whitespace as distinct", async () => {
    const { db, store } = await setup();
    await db.exec(
      "INSERT INTO foods(food_name,calories_kcal) VALUES ('Apple',95),('apple',80),('App le',70),('Apple',99)",
    );
    expect(await store.findFood("Apple")).toBe(95);
    expect(await store.findFood("apple")).toBe(80);
    expect(await store.findFood("App le")).toBe(70);
    expect(await store.findFood(" Apple ")).toBeNull();
  });
});
