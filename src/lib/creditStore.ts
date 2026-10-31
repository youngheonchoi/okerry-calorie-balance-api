import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ApiError, type Query } from "./errors";

export type Wallet = { remainingCount: number; reservedCount: number };
export type CalorieResult = {
  foodName: string;
  caloriesKcal: number;
  source: "storage" | "db" | "ai";
};
export type Reservation = {
  state: "new" | "pending" | "failed" | "succeeded";
  wallet: Wallet;
  result?: CalorieResult;
};
export interface CreditStore {
  status(userId: string): Promise<Wallet>;
  prepareReward(userId: string): Promise<{ eventId: string; wallet: Wallet }>;
  completeReward(userId: string, eventId: string): Promise<Wallet>;
  cancelReward(userId: string, eventId: string): Promise<Wallet>;
  reserve(userId: string, id: string, foodName: string): Promise<Reservation>;
  succeed(userId: string, id: string, result: CalorieResult): Promise<Wallet>;
  fail(userId: string, id: string): Promise<Wallet>;
  findFood(foodName: string): Promise<number | null>;
}
type History = {
  id: string;
  user_id: string;
  event_type: string;
  status: string;
  food_name: string | null;
  result_source: CalorieResult["source"] | null;
  calories_kcal: string | number | null;
};
const walletFrom = (row: Record<string, unknown>): Wallet => ({
  remainingCount: Number(row.remaining_count),
  reservedCount: Number(row.reserved_count),
});

// Every mutation locks the same user's wallet, then history: consistent lock order.
export function createPgCreditStore(pool: {
  connect: () => Promise<PoolClient>;
  query: Query;
}): CreditStore {
  async function transaction<T>(
    userId: string,
    run: (client: PoolClient, wallet: Wallet) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO user_calorie_credits (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [userId],
      );
      const locked = await client.query(
        "SELECT * FROM user_calorie_credits WHERE user_id = $1 FOR UPDATE",
        [userId],
      );
      const wallet = walletFrom(locked.rows[0]);
      const expired = await client.query(
        `UPDATE calorie_credit_history SET status = 'failed', finished_at = now()
         WHERE user_id = $1 AND status = 'pending' AND reserved_until <= now()
         RETURNING event_type`,
        [userId],
      );
      const count = expired.rows.filter(
        (row) => row.event_type === "calculation",
      ).length;
      if (count) {
        const updated = await client.query(
          "UPDATE user_calorie_credits SET reserved_count = reserved_count - $2, updated_at = now() WHERE user_id = $1 RETURNING *",
          [userId, count],
        );
        Object.assign(wallet, walletFrom(updated.rows[0]));
      }
      const result = await run(client, wallet);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function history(
    client: PoolClient,
    userId: string,
    id: string,
    type: string,
  ) {
    const result = await client.query<History>(
      "SELECT * FROM calorie_credit_history WHERE id = $1 FOR UPDATE",
      [id],
    );
    const row = result.rows[0];
    if (!row || row.user_id !== userId || row.event_type !== type)
      throw new ApiError("REQUEST_CONFLICT", 409);
    return row;
  }
  async function updateWallet(
    client: PoolClient,
    userId: string,
    remainingDelta: number,
    reservedDelta: number,
  ) {
    const result = await client.query(
      `UPDATE user_calorie_credits SET remaining_count = remaining_count + $2,
       reserved_count = reserved_count + $3, updated_at = now() WHERE user_id = $1 RETURNING *`,
      [userId, remainingDelta, reservedDelta],
    );
    return walletFrom(result.rows[0]);
  }
  return {
    status: (userId) => transaction(userId, async (_client, wallet) => wallet),
    prepareReward: (userId) =>
      transaction(userId, async (client, wallet) => {
        if (wallet.remainingCount !== 0 || wallet.reservedCount !== 0)
          throw new ApiError("CREDITS_REMAINING", 409);
        const pending = await client.query(
          "SELECT id FROM calorie_credit_history WHERE user_id = $1 AND event_type = 'reward' AND status = 'pending' LIMIT 1",
          [userId],
        );
        if (pending.rows[0]) return { eventId: pending.rows[0].id, wallet };
        const eventId = randomUUID();
        await client.query(
          "INSERT INTO calorie_credit_history (id, user_id, event_type, credit_change) VALUES ($1, $2, 'reward', 5)",
          [eventId, userId],
        );
        return { eventId, wallet };
      }),
    completeReward: (userId, eventId) =>
      transaction(userId, async (client, wallet) => {
        const row = await history(client, userId, eventId, "reward");
        if (row.status === "succeeded") return wallet;
        if (row.status !== "pending") throw new ApiError("REWARD_EXPIRED", 409);
        if (wallet.remainingCount !== 0 || wallet.reservedCount !== 0)
          throw new ApiError("CREDITS_REMAINING", 409);
        await client.query(
          "UPDATE calorie_credit_history SET status = 'succeeded', finished_at = now() WHERE id = $1",
          [eventId],
        );
        return updateWallet(client, userId, 5, 0);
      }),
    cancelReward: (userId, eventId) =>
      transaction(userId, async (client, wallet) => {
        const row = await history(client, userId, eventId, "reward");
        if (row.status === "pending")
          await client.query(
            "UPDATE calorie_credit_history SET status = 'failed', finished_at = now() WHERE id = $1",
            [eventId],
          );
        return wallet;
      }),
    reserve: (userId, id, foodName) =>
      transaction(userId, async (client, wallet) => {
        const found = await client.query<History>(
          "SELECT * FROM calorie_credit_history WHERE id = $1 FOR UPDATE",
          [id],
        );
        const row = found.rows[0];
        if (row) {
          if (
            row.user_id !== userId ||
            row.event_type !== "calculation" ||
            row.food_name !== foodName
          )
            throw new ApiError("REQUEST_CONFLICT", 409);
          if (row.status === "succeeded")
            return {
              state: "succeeded",
              wallet,
              result: {
                foodName,
                caloriesKcal: Number(row.calories_kcal),
                source: row.result_source!,
              },
            };
          return {
            state: row.status === "pending" ? "pending" : "failed",
            wallet,
          };
        }
        if (wallet.remainingCount - wallet.reservedCount <= 0)
          throw new ApiError("NO_CREDITS", 409);
        await client.query(
          "INSERT INTO calorie_credit_history (id, user_id, event_type, credit_change, food_name) VALUES ($1, $2, 'calculation', -1, $3)",
          [id, userId, foodName],
        );
        return {
          state: "new",
          wallet: await updateWallet(client, userId, 0, 1),
        };
      }),
    succeed: (userId, id, result) =>
      transaction(userId, async (client, wallet) => {
        const row = await history(client, userId, id, "calculation");
        if (row.status === "succeeded") return wallet;
        if (row.status !== "pending") throw new ApiError("REQUEST_FAILED", 409);
        if (row.food_name !== result.foodName)
          throw new ApiError("REQUEST_CONFLICT", 409);
        await client.query(
          "UPDATE calorie_credit_history SET status = 'succeeded', result_source = $2, calories_kcal = $3, finished_at = now() WHERE id = $1",
          [id, result.source, result.caloriesKcal],
        );
        return updateWallet(client, userId, -1, -1);
      }),
    fail: (userId, id) =>
      transaction(userId, async (client, wallet) => {
        const row = await history(client, userId, id, "calculation");
        if (row.status !== "pending") return wallet;
        await client.query(
          "UPDATE calorie_credit_history SET status = 'failed', finished_at = now() WHERE id = $1",
          [id],
        );
        return updateWallet(client, userId, 0, -1);
      }),
    async findFood(foodName) {
      const result = await pool.query(
        'SELECT calories_kcal FROM foods WHERE food_name = $1 COLLATE "C" ORDER BY id ASC LIMIT 1',
        [foodName],
      );
      return result.rows[0] ? Number(result.rows[0].calories_kcal) : null;
    },
  };
}
