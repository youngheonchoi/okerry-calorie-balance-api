import { getPool } from "@/lib/db";
import { createErrorLogger, type Query } from "@/lib/errors";
import { createFoodHandlers } from "@/lib/foodHandlers";
import { exchangeAnonymousCode } from "@/lib/toss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query: Query = (sql, values) => getPool().query(sql, values);
const handlers = createFoodHandlers({
  query,
  exchange: exchangeAnonymousCode,
  log: createErrorLogger(query),
});
export const GET = handlers.GET;
export const POST = handlers.POST;
export const OPTIONS = handlers.OPTIONS;
