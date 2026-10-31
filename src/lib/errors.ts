export type Query = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

const messages: Record<string, string> = {
  AUTH_NOT_CONFIGURED: "사용자 확인 설정이 준비되지 않았어요.",
  AUTH_REJECTED: "사용자를 확인하지 못했어요.",
  AUTH_UNAVAILABLE: "사용자 확인 요청을 완료하지 못했어요.",
  DATABASE_UNAVAILABLE: "데이터베이스 요청을 완료하지 못했어요.",
  SCHEMA_NOT_READY: "데이터베이스 테이블이 준비되지 않았어요.",
  HEALTH_UNAVAILABLE: "앱에서 서버 상태를 확인하지 못했어요.",
  AUTH_CODE_FAILED: "앱에서 사용자 인증 코드를 발급하지 못했어요.",
  FOOD_REQUEST_FAILED: "앱에서 음식 등록 요청을 완료하지 못했어요.",
};

export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 503,
  ) {
    super(messages[code] ?? "요청을 완료하지 못했어요.");
  }
}

export type ErrorEntry = {
  requestId: string;
  userId?: string;
  endpoint: string;
  stage: string;
  errorCode: string;
  occurredAt?: string;
};
export type ErrorLogger = (entry: ErrorEntry) => Promise<boolean>;

export function createErrorLogger(query: Query): ErrorLogger {
  return async (entry) => {
    const message =
      messages[entry.errorCode] ?? "요청 처리 중 오류가 발생했어요.";
    try {
      await query(
        `INSERT INTO api_error_logs
         (request_id, user_id, endpoint, stage, error_code, message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))`,
        [
          entry.requestId,
          entry.userId ?? null,
          entry.endpoint,
          entry.stage,
          entry.errorCode,
          message,
          entry.occurredAt ?? null,
        ],
      );
      return true;
    } catch {
      // Do not include raw exception messages, request bodies, keys or user IDs.
      console.error(
        JSON.stringify({
          event: "api_error_log_fallback",
          requestId: entry.requestId,
          endpoint: entry.endpoint,
          stage: entry.stage,
          errorCode: entry.errorCode,
        }),
      );
      return false;
    }
  };
}
