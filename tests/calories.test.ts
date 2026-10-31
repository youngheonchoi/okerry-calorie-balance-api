import { describe, expect, it, vi } from "vitest";
import { createCalorieService } from "../src/lib/calorieService";
import { createCalorieHandlers } from "../src/lib/calorieHandlers";
import { createCalorieEstimator } from "../src/lib/openaiCalories";
import { ApiError } from "../src/lib/errors";
import type { CreditStore } from "../src/lib/creditStore";
const id = "c998c500-086a-4b14-b60c-786f2f644a5e";
function setup() {
  const store = {
    status: vi.fn().mockResolvedValue({ remainingCount: 5, reservedCount: 0 }),
    reserve: vi
      .fn()
      .mockResolvedValue({
        state: "new",
        wallet: { remainingCount: 5, reservedCount: 1 },
      }),
    succeed: vi.fn().mockResolvedValue({ remainingCount: 4, reservedCount: 0 }),
    fail: vi.fn().mockResolvedValue({ remainingCount: 5, reservedCount: 0 }),
    findFood: vi.fn().mockResolvedValue(null),
    prepareReward: vi
      .fn()
      .mockResolvedValue({
        eventId: id,
        wallet: { remainingCount: 0, reservedCount: 0 },
      }),
    completeReward: vi
      .fn()
      .mockResolvedValue({ remainingCount: 5, reservedCount: 0 }),
    cancelReward: vi
      .fn()
      .mockResolvedValue({ remainingCount: 0, reservedCount: 0 }),
  } satisfies CreditStore;
  const estimate = vi.fn().mockResolvedValue(95),
    exchange = vi.fn().mockResolvedValue("verified-user"),
    log = vi.fn().mockResolvedValue(true);
  return { store, estimate, exchange, log };
}
describe("calorie lookup order and spending", () => {
  it("uses exact storage result before DB and AI", async () => {
    const app = setup();
    const calculate = createCalorieService(app.store, app.estimate);
    const result = await calculate("user", id, "Apple", {
      foodName: "Apple",
      caloriesKcal: 90,
    });
    expect(result).toMatchObject({
      remainingCount: 4,
      result: { source: "storage", caloriesKcal: 90 },
    });
    expect(app.store.findFood).not.toHaveBeenCalled();
    expect(app.estimate).not.toHaveBeenCalled();
    expect(app.store.succeed).toHaveBeenCalledOnce();
  });
  it.each(["apple", "App le", " Apple "])(
    "rejects a nonexact local candidate %s and searches the raw name",
    async (name) => {
      const app = setup();
      app.store.findFood.mockResolvedValue(77);
      const result = await createCalorieService(app.store, app.estimate)(
        "user",
        id,
        name,
        { foodName: "Apple", caloriesKcal: 90 },
      );
      expect(app.store.findFood).toHaveBeenCalledWith(name);
      expect(result.result.source).toBe("db");
      expect(app.estimate).not.toHaveBeenCalled();
    },
  );
  it("uses AI only after both misses", async () => {
    const app = setup();
    const result = await createCalorieService(app.store, app.estimate)(
      "user",
      id,
      "Apple",
    );
    expect(app.estimate).toHaveBeenCalledWith("Apple");
    expect(result.result.source).toBe("ai");
  });
  it.each([null, new ApiError("AI_UNAVAILABLE")])(
    "releases the reservation and never spends on missing/failed AI",
    async (value) => {
      const app = setup();
      if (value instanceof Error) app.estimate.mockRejectedValue(value);
      else app.estimate.mockResolvedValue(value);
      await expect(
        createCalorieService(app.store, app.estimate)("user", id, "???"),
      ).rejects.toThrow();
      expect(app.store.fail).toHaveBeenCalledWith("user", id);
      expect(app.store.succeed).not.toHaveBeenCalled();
    },
  );
  it("returns a saved replay without charging or calling AI again", async () => {
    const app = setup();
    app.store.reserve.mockResolvedValue({
      state: "succeeded",
      wallet: { remainingCount: 4, reservedCount: 0 },
      result: { foodName: "Apple", source: "ai", caloriesKcal: 95 },
    });
    expect(
      (await createCalorieService(app.store, app.estimate)("user", id, "Apple"))
        .result.caloriesKcal,
    ).toBe(95);
    expect(app.store.succeed).not.toHaveBeenCalled();
    expect(app.estimate).not.toHaveBeenCalled();
  });
  it.each(["pending", "failed"])(
    "does not rerun an existing %s calculation",
    async (state) => {
      const app = setup();
      app.store.reserve.mockResolvedValue({
        state,
        wallet: { remainingCount: 5, reservedCount: 1 },
      });
      await expect(
        createCalorieService(app.store, app.estimate)("user", id, "Apple"),
      ).rejects.toThrow();
      expect(app.estimate).not.toHaveBeenCalled();
    },
  );
  it("does not run AI without an available reservation", async () => {
    const app = setup();
    app.store.reserve.mockRejectedValue(new ApiError("NO_CREDITS", 409));
    await expect(
      createCalorieService(app.store, app.estimate)("user", id, "Apple"),
    ).rejects.toThrow();
    expect(app.estimate).not.toHaveBeenCalled();
  });
});
function request(body: unknown) {
  return new Request("https://api.example.com/api/calories", {
    method: "POST",
    headers: {
      Origin: "https://okerry-calorie-balance.apps.tossmini.com",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
describe("calorie API identity and missing ad ID", () => {
  it("derives the wallet owner from the exchanged code", async () => {
    const app = setup();
    const api = createCalorieHandlers({ ...app, adGroupId: () => "" });
    const response = await api.POST(
      request({ action: "status", code: "code" }),
    );
    expect(await response.json()).toMatchObject({
      remainingCount: 5,
      rewardAvailable: false,
      adGroupId: null,
    });
    expect(app.store.status).toHaveBeenCalledWith("verified-user");
    const grant = await api.POST(
      request({ action: "reward_prepare", code: "code" }),
    );
    expect(grant.status).toBe(409);
    expect(app.store.prepareReward).not.toHaveBeenCalled();
  });
  it("rejects forged userId and never accesses a wallet on invalid identity", async () => {
    const app = setup();
    const api = createCalorieHandlers({ ...app, adGroupId: () => "test" });
    expect(
      (
        await api.POST(
          request({ action: "status", code: "code", userId: "victim" }),
        )
      ).status,
    ).toBe(400);
    app.exchange.mockRejectedValue(new ApiError("AUTH_REJECTED", 401));
    expect(
      (await api.POST(request({ action: "status", code: "code" }))).status,
    ).toBe(401);
    expect(app.store.status).not.toHaveBeenCalled();
  });
  it("uploads only validated client errors after verified identity", async () => {
    const app = setup();
    const api = createCalorieHandlers({ ...app, adGroupId: () => "test" });
    const response = await api.POST(
      request({
        action: "status",
        code: "code",
        clientErrors: [
          {
            requestId: id,
            occurredAt: new Date().toISOString(),
            stage: "calorie_request",
            errorCode: "CALORIE_REQUEST_FAILED",
          },
        ],
      }),
    );
    expect(await response.json()).toMatchObject({ clientErrorsRecorded: true });
    expect(app.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "verified-user",
        errorCode: "CALORIE_REQUEST_FAILED",
      }),
    );
  });
});
describe("structured AI output", () => {
  const response = (content: unknown) =>
    new Response(
      JSON.stringify({ status: "completed", output: [{ content }] }),
    );
  it("sends only the food name and validates the numeric result", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response([
          {
            type: "output_text",
            text: '{"recognized":true,"calories_kcal":95}',
          },
        ]),
      );
    expect(
      await createCalorieEstimator({ apiKey: "secret", fetcher })("Apple"),
    ).toBe(95);
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.input).toBe('{"food_name":"Apple"}');
    expect(body.store).toBe(false);
    expect(body.text.format.type).toBe("json_schema");
  });
  it.each([
    '{"recognized":true,"calories_kcal":-1}',
    '{"recognized":true,"calories_kcal":"95"}',
  ])("rejects invalid provider output %s", async (text) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ type: "output_text", text }]));
    await expect(
      createCalorieEstimator({ apiKey: "secret", fetcher })("Apple"),
    ).rejects.toMatchObject({ code: "AI_INVALID_RESULT" });
  });
  it("does not fabricate calories for a refusal", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ type: "refusal", refusal: "no" }]));
    await expect(
      createCalorieEstimator({ apiKey: "secret", fetcher })("???"),
    ).resolves.toBeNull();
  });
  it("does not leak provider error bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret-provider-body", { status: 429 }));
    await expect(
      createCalorieEstimator({ apiKey: "secret", fetcher })("Apple"),
    ).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });
  });
});
