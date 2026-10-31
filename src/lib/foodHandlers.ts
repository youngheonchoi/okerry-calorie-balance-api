import { z } from "zod";
import { ApiError, type Query, type ErrorLogger } from "./errors";
import {
  getRequestId,
  isAllowedRequest,
  jsonResponse,
  preflight,
} from "./http";

const clientError = z
  .object({
    requestId: z.uuid(),
    stage: z.enum(["health_check", "identity", "food_save"]),
    errorCode: z.enum([
      "HEALTH_UNAVAILABLE",
      "AUTH_CODE_FAILED",
      "FOOD_REQUEST_FAILED",
    ]),
    occurredAt: z.iso.datetime(),
  })
  .strict();
const foodInput = z
  .object({
    code: z.string().min(1).max(2000),
    foodName: z
      .string()
      .min(1)
      .max(100)
      .refine((name) => name.trim().length > 0),
    caloriesKcal: z.number().finite().min(0).max(10000),
    quantity: z.number().int().min(1).max(999),
    clientErrors: z.array(clientError).max(20).default([]),
  })
  .strict();

export function createFoodHandlers({
  query,
  exchange,
  log,
}: {
  query: Query;
  exchange: (code: string) => Promise<string>;
  log: ErrorLogger;
}) {
  return {
    OPTIONS: preflight,
    async GET(request: Request) {
      const requestId = getRequestId(request);
      if (!isAllowedRequest(request))
        return jsonResponse(
          request,
          requestId,
          { error: "ORIGIN_NOT_ALLOWED" },
          403,
        );
      const name = new URL(request.url).searchParams.get("name");
      if (!name || name.length > 100 || !name.trim())
        return jsonResponse(request, requestId, { error: "INVALID_NAME" }, 400);
      try {
        const result = await query(
          `SELECT id, food_name, calories_kcal, quantity, created_at
           FROM foods WHERE food_name = $1 COLLATE "C" LIMIT 1`,
          [name],
        );
        return jsonResponse(request, requestId, {
          status: "ok",
          foods: result.rows,
        });
      } catch {
        await log({
          requestId,
          endpoint: "/api/foods",
          stage: "food_search",
          errorCode: "DATABASE_UNAVAILABLE",
        });
        return jsonResponse(
          request,
          requestId,
          { error: "DATABASE_UNAVAILABLE" },
          503,
        );
      }
    },
    async POST(request: Request) {
      const requestId = getRequestId(request);
      if (!isAllowedRequest(request))
        return jsonResponse(
          request,
          requestId,
          { error: "ORIGIN_NOT_ALLOWED" },
          403,
        );
      if (Number(request.headers.get("Content-Length")) > 12000)
        return jsonResponse(
          request,
          requestId,
          { error: "BODY_TOO_LARGE" },
          413,
        );
      let raw: string;
      try {
        raw = await request.text();
      } catch {
        return jsonResponse(request, requestId, { error: "INVALID_BODY" }, 400);
      }
      if (Buffer.byteLength(raw) > 12000)
        return jsonResponse(
          request,
          requestId,
          { error: "BODY_TOO_LARGE" },
          413,
        );
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return jsonResponse(request, requestId, { error: "INVALID_BODY" }, 400);
      }
      const parsed = foodInput.safeParse(body);
      if (!parsed.success)
        return jsonResponse(request, requestId, { error: "INVALID_FOOD" }, 400);
      const input = parsed.data;
      let userId: string | undefined;
      let stage = "identity";
      try {
        // Never accept a client-supplied user_id/anonKey as identity.
        userId = await exchange(input.code);
        stage = "food_save";
        const result = await query(
          `INSERT INTO foods (user_id, food_name, calories_kcal, quantity)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (food_name) DO NOTHING RETURNING id`,
          [userId, input.foodName, input.caloriesKcal, input.quantity],
        );
        let clientErrorsRecorded = true;
        for (const error of input.clientErrors) {
          const recorded = await log({
            requestId: error.requestId,
            userId,
            endpoint: "/api/foods",
            stage: `client_${error.stage}`,
            errorCode: error.errorCode,
            occurredAt: error.occurredAt,
          });
          if (!recorded) clientErrorsRecorded = false;
        }
        return jsonResponse(
          request,
          requestId,
          {
            status: "ok",
            created: result.rows.length > 0,
            id: result.rows[0]?.id ?? null,
            clientErrorsRecorded,
          },
          result.rows.length ? 201 : 200,
        );
      } catch (error) {
        const failure =
          error instanceof ApiError
            ? error
            : new ApiError("DATABASE_UNAVAILABLE");
        await log({
          requestId,
          userId,
          endpoint: "/api/foods",
          stage,
          errorCode: failure.code,
        });
        return jsonResponse(
          request,
          requestId,
          { error: failure.code },
          failure.status,
        );
      }
    },
  };
}
