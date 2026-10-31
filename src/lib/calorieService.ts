import { ApiError } from "./errors";
import type { CalorieResult, CreditStore } from "./creditStore";

export function createCalorieService(
  store: CreditStore,
  estimate: (foodName: string) => Promise<number | null>,
) {
  return async (
    userId: string,
    id: string,
    foodName: string,
    localResult?: { foodName: string; caloriesKcal: number },
  ) => {
    const reserved = await store.reserve(userId, id, foodName);
    if (reserved.state === "succeeded")
      return { ...reserved.wallet, result: reserved.result! };
    if (reserved.state === "pending")
      throw new ApiError("REQUEST_PENDING", 409);
    if (reserved.state === "failed") throw new ApiError("REQUEST_FAILED", 409);
    try {
      let result: CalorieResult;
      if (
        localResult &&
        localResult.foodName === foodName &&
        Number.isFinite(localResult.caloriesKcal) &&
        localResult.caloriesKcal >= 0 &&
        localResult.caloriesKcal <= 10000
      ) {
        result = {
          foodName,
          caloriesKcal: localResult.caloriesKcal,
          source: "storage",
        };
      } else {
        const fromDb = await store.findFood(foodName);
        if (fromDb !== null)
          result = { foodName, caloriesKcal: fromDb, source: "db" };
        else {
          const calories = await estimate(foodName);
          if (calories === null) throw new ApiError("NO_RESULT", 422);
          result = { foodName, caloriesKcal: calories, source: "ai" };
        }
      }
      const wallet = await store.succeed(userId, id, result);
      return { ...wallet, result };
    } catch (error) {
      // If this fails too, the bounded reservation expires and is released on
      // the next wallet request. Never decrement committed credits on failure.
      await store.fail(userId, id).catch(() => undefined);
      throw error;
    }
  };
}
