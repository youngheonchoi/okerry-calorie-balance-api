import { getPool } from "@/lib/db";
import { createErrorLogger } from "@/lib/errors";
import { exchangeAnonymousCode } from "@/lib/toss";
import { createPgCreditStore } from "@/lib/creditStore";
import { createCalorieHandlers } from "@/lib/calorieHandlers";
import { createCalorieEstimator } from "@/lib/openaiCalories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Lazy pool access keeps builds independent from production credentials.
const store = createPgCreditStore({
  connect: () => getPool().connect(),
  query: (sql, values) => getPool().query(sql, values),
});
const handlers = createCalorieHandlers({
  store,
  exchange: exchangeAnonymousCode,
  estimate: createCalorieEstimator(),
  log: createErrorLogger((sql, values) => getPool().query(sql, values)),
  adGroupId: () => process.env.TOSS_REWARDED_AD_GROUP_ID || "",
});
export const POST = handlers.POST;
export const OPTIONS = handlers.OPTIONS;
