import { randomUUID } from "node:crypto";

export function getRequestId(request: Request) {
  const id = request.headers.get("X-Request-Id");
  return id &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
    ? id
    : randomUUID();
}

function allowedOrigins() {
  const origins = new Set([
    "https://okerry-calorie-balance.apps.tossmini.com",
    "https://okerry-calorie-balance.private-apps.tossmini.com",
  ]);
  if (process.env.ALLOW_LOCAL_DEV_ORIGINS === "true") {
    for (const host of ["localhost", "127.0.0.1"]) {
      for (const port of [5173, 5180]) origins.add(`http://${host}:${port}`);
    }
  }
  return origins;
}

export function isAllowedRequest(request: Request) {
  const origin = request.headers.get("Origin");
  return !origin || allowedOrigins().has(origin);
}

export function jsonResponse(
  request: Request,
  requestId: string,
  body: unknown,
  status = 200,
) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
    Vary: "Origin",
  });
  const origin = request.headers.get("Origin");
  if (origin && allowedOrigins().has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "X-Request-Id");
  }
  return Response.json(body, { status, headers });
}

export function preflight(request: Request) {
  if (!isAllowedRequest(request)) return new Response(null, { status: 403 });
  const origin = request.headers.get("Origin");
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Request-Id",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(null, { status: 204, headers });
}
