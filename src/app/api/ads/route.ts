import { createAdConfigHandlers } from "@/lib/adConfigHandlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createAdConfigHandlers(
  () => process.env.TOSS_EXPORT_REWARDED_AD_GROUP_ID || "",
);
export const GET = handlers.GET;
export const OPTIONS = handlers.OPTIONS;
