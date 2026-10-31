import { ApiError, type Query, type ErrorLogger } from "./errors";
import {
  getRequestId,
  isAllowedRequest,
  jsonResponse,
  preflight,
} from "./http";

export function createHealthHandlers({
  query,
  log,
  authenticationConfigured,
}: {
  query: Query;
  log: ErrorLogger;
  authenticationConfigured: () => boolean;
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
      try {
        const result = await query(`SELECT to_regclass('public.foods') AS foods,
          to_regclass('public.api_error_logs') AS logs`);
        if (!result.rows[0]?.foods || !result.rows[0]?.logs)
          throw new ApiError("SCHEMA_NOT_READY");
        if (!authenticationConfigured())
          throw new ApiError("AUTH_NOT_CONFIGURED");
        return jsonResponse(request, requestId, {
          status: "ok",
          service: "okerry-calorie-balance-api",
        });
      } catch (error) {
        const failure =
          error instanceof ApiError
            ? error
            : new ApiError("DATABASE_UNAVAILABLE");
        await log({
          requestId,
          endpoint: "/api/health",
          stage: "health_check",
          errorCode: failure.code,
        });
        return jsonResponse(
          request,
          requestId,
          { status: "unavailable", service: "okerry-calorie-balance-api" },
          503,
        );
      }
    },
  };
}
