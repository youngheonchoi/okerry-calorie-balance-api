import { getPool } from "@/lib/db";
import { createErrorLogger, type Query } from "@/lib/errors";
import { createHealthHandlers } from "@/lib/healthHandlers";
import { isTossConfigured } from "@/lib/toss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query: Query = (sql, values) => getPool().query(sql, values);
const handlers = createHealthHandlers({
  query,
  log: createErrorLogger(query),
  authenticationConfigured: isTossConfigured,
});
export const GET = handlers.GET;
export const OPTIONS = handlers.OPTIONS;
