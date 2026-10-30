import { z } from "zod";
import { getPool } from "@/lib/db";

const foodInput = z.object({
  name: z.string().trim().min(1).max(80),
  calories: z.number().int().min(0).max(5000),
  serving: z.string().trim().min(1).max(40).default("1회 제공량"),
});

const normalize = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ko-KR");

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
  if (name.length < 1 || name.length > 80) {
    return Response.json({ error: "name은 1~80자여야 해요." }, { status: 400 });
  }
  try {
    const result = await getPool().query(
      `SELECT id, name, calories, serving, contribution_count AS "contributionCount"
       FROM shared_foods
       WHERE normalized_name = $1
       ORDER BY contribution_count DESC, updated_at DESC
       LIMIT 10`,
      [normalize(name)],
    );
    return Response.json({ foods: result.rows }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "음식 정보를 불러오지 못했어요." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON 요청 본문이 필요해요." }, { status: 400 });
  }
  const parsed = foodInput.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "음식명, 기준량, 칼로리 값을 확인해주세요." }, { status: 400 });
  }
  const food = parsed.data;
  try {
    const result = await getPool().query(
      `INSERT INTO shared_foods (name, normalized_name, calories, serving)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (normalized_name, serving) DO UPDATE SET
         name = EXCLUDED.name,
         calories = ROUND((shared_foods.calories * shared_foods.contribution_count + EXCLUDED.calories)::numeric / (shared_foods.contribution_count + 1))::integer,
         contribution_count = shared_foods.contribution_count + 1,
         updated_at = now()
       RETURNING id, name, calories, serving, contribution_count AS "contributionCount"`,
      [food.name, normalize(food.name), food.calories, food.serving],
    );
    return Response.json({ food: result.rows[0] }, { status: 201 });
  } catch {
    return Response.json({ error: "음식 정보를 저장하지 못했어요." }, { status: 503 });
  }
}
