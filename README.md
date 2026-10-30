# okerry-calorie-balance-api

Vercel에 배포하는 Next.js App Router API 전용 프로젝트입니다.

## API

- `GET /api/health` — 서버 상태 확인
- `GET /api/foods?name=김밥` — 공유 음식명으로 검색
- `POST /api/foods` — 공유 음식 등록 또는 기존 기록 기여

```json
{
  "name": "김밥",
  "calories": 450,
  "serving": "1줄"
}
```

칼로리는 해당 기준량에 대한 kcal 정수로 저장합니다. 같은 음식명과 기준량이 들어오면 칼로리 평균과 기여 횟수를 갱신합니다.

## 데이터베이스 설정

1. Vercel에서 PostgreSQL 호환 데이터베이스(예: Neon)를 연결합니다.
2. `DATABASE_URL`을 로컬 `.env.local`과 Vercel 환경 변수에 등록합니다.
3. `database/schema.sql`을 데이터베이스에 실행합니다.

API는 데이터베이스가 없거나 연결할 수 없을 때 `503`을 반환합니다. 현재 음식 등록 API에는 사용자 인증/기여자 검증이 없습니다. 공개 운영 전에는 요청 제한과 잘못된 데이터 대응 정책을 추가해야 합니다.
