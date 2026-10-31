import { request as httpsRequest } from "node:https";
import { ApiError } from "./errors";

type Env = Record<string, string | undefined>;
type ExchangeOptions = {
  hostname: string;
  path: string;
  method: "POST";
  headers: Record<string, string | number>;
  cert: string;
  key: string;
  body: string;
};
type Transport = (
  options: ExchangeOptions,
) => Promise<{ status: number; body: unknown }>;

export function isTossConfigured(env: Env = process.env) {
  return !!env.TOSS_MTLS_CERT?.trim() && !!env.TOSS_MTLS_KEY?.trim();
}

const postExchange: Transport = (options) =>
  new Promise((resolve, reject) => {
    const { body, ...httpsOptions } = options;
    const request = httpsRequest(
      {
        ...httpsOptions,
        port: 443,
        rejectUnauthorized: true,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65536) request.destroy(new Error("Response too large"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 500,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            reject(new Error("Invalid exchange response"));
          }
        });
      },
    );
    request.setTimeout(8000, () =>
      request.destroy(new Error("Exchange timed out")),
    );
    request.on("error", reject);
    request.end(body);
  });

export async function exchangeAnonymousCode(
  code: string,
  transport: Transport = postExchange,
  env: Env = process.env,
) {
  if (!isTossConfigured(env)) throw new ApiError("AUTH_NOT_CONFIGURED");
  const body = JSON.stringify({ code });
  let response: Awaited<ReturnType<Transport>>;
  try {
    response = await transport({
      hostname: "apps-in-toss-api.toss.im",
      path: "/api-partner/v1/apps-in-toss/users/anon-key/exchange",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      cert: env.TOSS_MTLS_CERT!.replace(/\\n/g, "\n"),
      key: env.TOSS_MTLS_KEY!.replace(/\\n/g, "\n"),
      body,
    });
  } catch {
    throw new ApiError("AUTH_UNAVAILABLE");
  }
  const result = response.body as {
    resultType?: unknown;
    success?: { anonKey?: unknown };
    error?: unknown;
  } | null;
  if (response.status >= 500) throw new ApiError("AUTH_UNAVAILABLE");
  if (
    response.status !== 200 ||
    !result ||
    result.resultType !== "SUCCESS" ||
    result.error != null ||
    typeof result.success?.anonKey !== "string" ||
    !result.success.anonKey.trim()
  ) {
    throw new ApiError("AUTH_REJECTED", 401);
  }
  return result.success.anonKey;
}
