import { z } from "zod";
import { ApiError, type ErrorLogger } from "./errors";
import type { CreditStore } from "./creditStore";
import { createCalorieService } from "./calorieService";
import {
  getRequestId,
  isAllowedRequest,
  jsonResponse,
  preflight,
} from "./http";

const base = {
  code: z.string().min(1).max(2000),
  clientErrors: z
    .array(
      z
        .object({
          requestId: z.uuid(),
          occurredAt: z.iso.datetime(),
          stage: z.literal("calorie_request"),
          errorCode: z.literal("CALORIE_REQUEST_FAILED"),
        })
        .strict(),
    )
    .max(20)
    .optional(),
};
const requestSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("status") }).strict(),
  z.object({ ...base, action: z.literal("reward_prepare") }).strict(),
  z
    .object({
      ...base,
      action: z.literal("reward_complete"),
      eventId: z.uuid(),
    })
    .strict(),
  z
    .object({ ...base, action: z.literal("reward_cancel"), eventId: z.uuid() })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("calculate"),
      calculationId: z.uuid(),
      foodName: z
        .string()
        .min(1)
        .max(100)
        .refine((s) => !!s.trim()),
      localResult: z
        .object({
          foodName: z.string().min(1).max(100),
          caloriesKcal: z.number().finite().min(0).max(10000),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
const operationalErrors = new Set([
  "NO_CREDITS",
  "CREDITS_REMAINING",
  "REQUEST_PENDING",
  "REQUEST_FAILED",
  "REQUEST_CONFLICT",
  "REWARD_EXPIRED",
  "AD_NOT_READY",
  "NO_RESULT",
]);

export function createCalorieHandlers({
  store,
  exchange,
  estimate,
  log,
  adGroupId,
}: {
  store: CreditStore;
  exchange: (code: string) => Promise<string>;
  estimate: (foodName: string) => Promise<number | null>;
  log: ErrorLogger;
  adGroupId: () => string;
}) {
  const calculate = createCalorieService(store, estimate);
  return {
    OPTIONS: preflight,
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
      let input: z.infer<typeof requestSchema>;
      try {
        const text = await request.text();
        if (Buffer.byteLength(text) > 12000)
          return jsonResponse(
            request,
            requestId,
            { error: "BODY_TOO_LARGE" },
            413,
          );
        input = requestSchema.parse(JSON.parse(text));
      } catch {
        return jsonResponse(
          request,
          requestId,
          { error: "INVALID_REQUEST" },
          400,
        );
      }
      let userId: string | undefined;
      let stage = "identity";
      try {
        userId = await exchange(input.code);
        let clientErrorsRecorded = true;
        for (const entry of input.clientErrors ?? []) {
          if (!(await log({ ...entry, userId, endpoint: "/api/calories" })))
            clientErrorsRecorded = false;
        }
        stage = input.action;
        const groupId = adGroupId().trim();
        const configuration = {
          clientErrorsRecorded,
          adGroupId: groupId || null,
          rewardAvailable: !!groupId,
        };
        if (input.action === "status")
          return jsonResponse(request, requestId, {
            status: "ok",
            ...configuration,
            ...(await store.status(userId)),
          });
        if (input.action === "reward_prepare") {
          if (!groupId) throw new ApiError("AD_NOT_READY", 409);
          const event = await store.prepareReward(userId);
          return jsonResponse(request, requestId, {
            status: "ok",
            ...configuration,
            eventId: event.eventId,
            ...event.wallet,
          });
        }
        if (input.action === "reward_complete") {
          // The SDK client invokes this ONLY on userEarnedReward. The SDK docs
          // expose no signed receipt here; this is not independent ad SSV.
          if (!groupId) throw new ApiError("AD_NOT_READY", 409);
          return jsonResponse(request, requestId, {
            status: "ok",
            ...configuration,
            ...(await store.completeReward(userId, input.eventId)),
          });
        }
        if (input.action === "reward_cancel")
          return jsonResponse(request, requestId, {
            status: "ok",
            ...configuration,
            ...(await store.cancelReward(userId, input.eventId)),
          });
        const result = await calculate(
          userId,
          input.calculationId,
          input.foodName,
          input.localResult,
        );
        return jsonResponse(request, requestId, {
          status: "ok",
          ...configuration,
          ...result,
        });
      } catch (error) {
        const failure =
          error instanceof ApiError
            ? error
            : new ApiError("DATABASE_UNAVAILABLE");
        if (!operationalErrors.has(failure.code))
          await log({
            requestId,
            userId,
            endpoint: "/api/calories",
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
