import {
  getRequestId,
  isAllowedRequest,
  jsonResponse,
  preflight,
} from "./http";

export function createAdConfigHandlers(exportGroupId: () => string) {
  return {
    OPTIONS: preflight,
    GET(request: Request) {
      const requestId = getRequestId(request);
      if (!isAllowedRequest(request))
        return jsonResponse(
          request,
          requestId,
          { error: "ORIGIN_NOT_ALLOWED" },
          403,
        );
      // Ad group IDs are public SDK configuration. No other env values leave the server.
      return jsonResponse(request, requestId, {
        status: "ok",
        exportRewardedAdGroupId: exportGroupId().trim() || null,
      });
    },
  };
}
