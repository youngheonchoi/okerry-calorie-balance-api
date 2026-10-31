import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createErrorLogger } from "../src/lib/errors";
import { createFoodHandlers } from "../src/lib/foodHandlers";
import { createHealthHandlers } from "../src/lib/healthHandlers";
import { exchangeAnonymousCode } from "../src/lib/toss";

const origin = "https://okerry-calorie-balance.apps.tossmini.com";
const food = {
  code: "one-use-code",
  foodName: "Apple",
  caloriesKcal: 95.5,
  quantity: 2,
};
const env = { TOSS_MTLS_CERT: "test-cert", TOSS_MTLS_KEY: "test-key" };
const request = (body: unknown, from = origin) =>
  new Request("https://example.com/api/foods", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: from },
    body: JSON.stringify(body),
  });
afterEach(() => vi.restoreAllMocks());

describe("anonymous code exchange", () => {
  it("uses the documented mTLS host/path and extracts success.anonKey", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue({
        status: 200,
        body: { resultType: "SUCCESS", success: { anonKey: "verified-user" } },
      });
    expect(await exchangeAnonymousCode("code", transport, env)).toBe(
      "verified-user",
    );
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "apps-in-toss-api.toss.im",
        path: "/api-partner/v1/apps-in-toss/users/anon-key/exchange",
        method: "POST",
        cert: "test-cert",
        key: "test-key",
        body: '{"code":"code"}',
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
  });
  it.each([
    { status: 200, body: { resultType: "FAIL", error: { errorCode: "4011" } } },
    { status: 200, body: { resultType: "FAIL", error: { errorCode: 4011 } } },
    { status: 400, body: { error: "invalid_grant" } },
    {
      status: 200,
      body: { resultType: "SUCCESS", success: { hash: "not-the-api-field" } },
    },
    { status: 200, body: { resultType: "SUCCESS", success: { anonKey: "" } } },
  ])("rejects failed or invalid envelopes %#", async (reply) => {
    await expect(
      exchangeAnonymousCode("code", async () => reply, env),
    ).rejects.toMatchObject({ code: "AUTH_REJECTED" });
  });
  it("does not invoke Toss when the certificate is missing", async () => {
    const transport = vi.fn();
    await expect(
      exchangeAnonymousCode("code", transport, {}),
    ).rejects.toMatchObject({ code: "AUTH_NOT_CONFIGURED" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("sanitizes transport errors", async () => {
    await expect(
      exchangeAnonymousCode(
        "code",
        async () => {
          throw new Error("secret private key");
        },
        env,
      ),
    ).rejects.toThrow("사용자 확인 요청을 완료하지 못했어요.");
  });
});

describe("food registration", () => {
  function setup() {
    const rows = new Map<string, unknown[]>();
    const query = vi.fn(async (_sql: string, values?: unknown[]) => {
      const name = String(values?.[1]);
      if (rows.has(name)) return { rows: [] };
      rows.set(name, values!);
      return { rows: [{ id: rows.size }] };
    });
    const exchange = vi.fn().mockResolvedValue("verified-user");
    const log = vi.fn().mockResolvedValue(true);
    return {
      ...createFoodHandlers({ query, exchange, log }),
      query,
      exchange,
      log,
      rows,
    };
  }
  it("keeps case and spaces, uses verified user identity, and never updates duplicates", async () => {
    const api = setup();
    for (const foodName of ["apple", "Apple", "app le"]) {
      expect((await api.POST(request({ ...food, foodName }))).status).toBe(201);
    }
    expect(
      (
        await api.POST(
          request({ ...food, foodName: "apple", caloriesKcal: 999 }),
        )
      ).status,
    ).toBe(200);
    expect(api.rows.size).toBe(3);
    expect(api.rows.get("apple")).toEqual(["verified-user", "apple", 95.5, 2]);
    expect(api.query.mock.calls[0][0]).toContain(
      "ON CONFLICT (food_name) DO NOTHING",
    );
  });
  it("rejects a client-supplied user ID before exchange", async () => {
    const api = setup();
    expect(
      (await api.POST(request({ ...food, user_id: "forged-user" }))).status,
    ).toBe(400);
    expect(api.exchange).not.toHaveBeenCalled();
    expect(api.query).not.toHaveBeenCalled();
  });
  it("never writes food when authentication fails, and logs a safe error", async () => {
    const api = setup();
    api.exchange.mockRejectedValue(new ApiError("AUTH_REJECTED", 401));
    expect((await api.POST(request(food))).status).toBe(401);
    expect(api.query).not.toHaveBeenCalled();
    expect(api.log).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "identity",
        errorCode: "AUTH_REJECTED",
      }),
    );
  });
  it("logs database failures without exposing raw errors", async () => {
    const api = setup();
    api.query.mockRejectedValue(new Error("postgresql://user:password@host"));
    const response = await api.POST(request(food));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("password");
    expect(api.log).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "verified-user", stage: "food_save" }),
    );
  });
  it("accepts buffered client errors only after user verification", async () => {
    const api = setup();
    const response = await api.POST(
      request({
        ...food,
        clientErrors: [
          {
            requestId: "6bfa5d45-072d-415e-bd4c-71328735c123",
            stage: "health_check",
            errorCode: "HEALTH_UNAVAILABLE",
            occurredAt: "2026-10-31T00:00:00.000Z",
          },
        ],
      }),
    );
    expect((await response.json()).clientErrorsRecorded).toBe(true);
    expect(api.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "verified-user",
        stage: "client_health_check",
      }),
    );
  });
  it("rejects a foreign origin and allows the exact miniapp origin", async () => {
    const api = setup();
    expect((await api.POST(request(food, "https://evil.example"))).status).toBe(
      403,
    );
    const response = await api.POST(request(food));
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const preflight = api.OPTIONS(
      new Request("https://example.com/api/foods", {
        method: "OPTIONS",
        headers: { Origin: origin },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
      "X-Request-Id",
    );
  });
  it("performs exact-name search without returning user identifiers", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const api = createFoodHandlers({ query, exchange: vi.fn(), log: vi.fn() });
    const response = await api.GET(
      new Request("https://example.com/api/foods?name=app%20le"),
    );
    expect(response.status).toBe(200);
    expect(query.mock.calls[0][1]).toEqual(["app le"]);
    expect(query.mock.calls[0][0]).not.toContain("user_id");
  });
});

describe("health and error logging", () => {
  it.each([
    {
      tables: { foods: "foods", logs: "api_error_logs" },
      configured: true,
      status: 200,
    },
    {
      tables: { foods: null, logs: "api_error_logs" },
      configured: true,
      status: 503,
    },
    {
      tables: { foods: "foods", logs: "api_error_logs" },
      configured: false,
      status: 503,
    },
  ])(
    "checks DB tables and authentication setup %#",
    async ({ tables, configured, status }) => {
      const api = createHealthHandlers({
        query: async () => ({ rows: [tables] }),
        authenticationConfigured: () => configured,
        log: vi.fn().mockResolvedValue(true),
      });
      expect(
        (await api.GET(new Request("https://example.com/api/health"))).status,
      ).toBe(status);
    },
  );
  it("writes sanitized DB logs and falls back without leaking raw exceptions", async () => {
    const query = vi
      .fn()
      .mockRejectedValue(new Error("secret connection string"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const log = createErrorLogger(query);
    expect(
      await log({
        requestId: "6bfa5d45-072d-415e-bd4c-71328735c123",
        userId: "private-user",
        endpoint: "/api/foods",
        stage: "food_save",
        errorCode: "DATABASE_UNAVAILABLE",
      }),
    ).toBe(false);
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(
      /secret|private-user/,
    );
    expect(query.mock.calls[0][0]).toContain("INSERT INTO api_error_logs");
    expect(query.mock.calls[0][1][5]).toBe(
      "데이터베이스 요청을 완료하지 못했어요.",
    );
  });
});
