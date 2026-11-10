# okerry-calorie-balance-api

Vercel Node.js에서 동작하는 Next.js + TypeScript API 프로젝트입니다.

## 음식 저장 흐름

1. 미니앱은 개인 기록을 앱인토스 Storage에 먼저 저장합니다.
2. 백그라운드에서 `GET /api/health`를 호출합니다. DB 테이블과 인증서 설정이 준비되면 `status: "ok"`를 반환합니다.
3. 미니앱이 `User.createAnonymousKeyAuthCode()`로 일회용 코드를 발급받습니다.
4. `POST /api/foods`가 mTLS로 코드를 교환하고, 서버가 받은 `success.anonKey`를 `foods.user_id`에 저장합니다. 클라이언트가 보낸 식별값은 받지 않습니다.
5. 음식명은 정리·소문자 변환 없이 그대로 저장합니다. `apple`, `Apple`, `app le`은 별개입니다. 완전히 같은 이름은 `ON CONFLICT DO NOTHING`으로 건너뛰며 기존 음식과 칼로리를 수정하지 않습니다.

```json
{
  "code": "SDK에서 방금 발급받은 일회용 코드",
  "foodName": "Apple",
  "caloriesKcal": 95,
  "quantity": 2,
  "clientErrors": []
}
```

칼로리는 수량을 곱하기 전 1개/1인분 기준값입니다. `quantity`가 2여도 `caloriesKcal`은 95입니다. 식사 날짜·끼니·메모·신체 정보는 업로드하지 않습니다.

- `GET /api/foods?name=Apple`: 정확히 일치하는 음식 검색. 사용자 식별값은 반환하지 않습니다.
- `POST /api/foods`: 신규 등록은 201, 기존 이름은 200. 응답에 `created`를 표시합니다.
- `GET /api/health`: DB 연결/테이블과 mTLS 환경변수 유무를 확인합니다. 설정이 없으면 503입니다. 실제 인증서의 유효성까지 확인한 상태를 뜻하지는 않습니다.

## Vercel 환경변수와 인증서

- `DATABASE_URL`: PostgreSQL 연결 문자열
- `TOSS_MTLS_CERT`: 이 미니앱의 `_public.crt` PEM 내용
- `TOSS_MTLS_KEY`: 이 미니앱의 `_private.key` PEM 내용
- `ALLOW_LOCAL_DEV_ORIGINS`: 로컬 브라우저 테스트 중에만 `true` (기본 `false`)

앱인토스 콘솔에서 해당 미니앱 → 개발 → mTLS 인증서 → 발급받기를 사용합니다. 다운로드한 인증서/개인 키 내용은 채팅·저장소에 올리지 않고 Vercel의 서버 환경변수에 직접 등록하세요. 실제 줄바꿈 또는 `\n`으로 구분된 PEM을 지원합니다. 변수 설정 후 재배포해야 적용됩니다.

`database/schema.sql`은 이미 생성한 `foods`, `api_error_logs`와 동일한 구조입니다. 기존 테이블을 삭제하거나 재생성하지 않아도 됩니다.

허용 Origin은 SDK 3.8.0에 맞춰 아래 두 주소만 기본 허용합니다.

- `https://okerry-calorie-balance.apps.tossmini.com`
- `https://okerry-calorie-balance.private-apps.tossmini.com`

Vercel Node.js 런타임이 제공하는 `node:https`의 클라이언트 인증서 옵션으로 mTLS를 구성합니다. 실제 Toss 연결 성공은 인증서 설정 후 기기에서 확인해야 합니다. 브라우저 SDK mock 코드는 실제 사용자 인증 코드가 아니며, 서버에서 인증을 우회하지 않습니다.

## 오류 기록

API의 DB/인증 오류는 `api_error_logs`에 기록합니다. 원본 예외 메시지, 요청 본문, 음식명, 인증 코드, 인증서·키는 로그에 넣지 않습니다. DB 로그 저장도 실패하면 안전한 오류 코드·요청 ID만 Vercel 런타임 로그에 기록합니다.

미니앱의 네트워크/상태 확인/SDK 오류는 기기 Storage에 최대 20개 임시 보관하고, 다음 음식 등록이 성공할 때 인증된 사용자 기준으로 오류 테이블에 전송합니다. API에 연결할 수 없는 동안에는 DB에 즉시 기록할 수 없습니다. 익명 사용자 식별 전 오류의 `user_id`는 null일 수 있습니다.

## 검증

`npm test`: 가짜 파트너 응답으로 성공/FAIL/HTTP 오류, 사용자 위조 거부, 정확한 이름 등록, 중복 등록, 오류 기록, CORS와 health 상태를 검증합니다. 실제 DB/인증서를 사용하지 않습니다.

`npm run build`: Next.js 프로덕션 빌드와 TypeScript 검사.

공식 근거:
- https://developers-apps-in-toss.toss.im/api/user-key
- https://developers-apps-in-toss.toss.im/documentation/sdk/domains-api/user/user.createanonymouskeyauthcode
- https://developers-apps-in-toss.toss.im/documentation/integration/server-api
- https://vercel.com/docs/functions/runtimes/node-js
- https://nodejs.org/api/https.html

## 칼로리 자동계산과 보상 횟수

`POST /api/calories`: 매 요청 `code`를 서버에서 교환합니다. action은 `status`, `reward_prepare`, `reward_complete`, `reward_cancel`, `calculate`입니다. complete/cancel은 `eventId`, calculate는 `calculationId`(UUID), `foodName`, 선택적인 `localResult: {foodName, caloriesKcal}`를 받습니다. userId는 받지 않습니다.

- 보상 1회 = 5회, 기간 제한 없음. 잔여 0일 때만 보상 세션 생성 가능.
- AI가 `recognized: false`를 반환하면 0 kcal를 정상 결과로 반환하고 1회 차감합니다. 통신 오류·잘못된 응답·refusal은 차감하지 않습니다.
- 결과를 성공적으로 저장한 계산만 1회 차감. 같은 calculationId 재전송은 기존 결과를 반환합니다.
- 동일 음식명의 Storage 후보 → 전체 회원 DB의 완전 일치 첫 행(id ASC) → AI 순입니다. 대소문자/공백을 변환하지 않습니다. 클라이언트 Storage 후보는 서버가 진위를 확인할 수 없는 사용자 입력입니다.
- 사용자 지갑 행 잠금과 예약 횟수로 병렬 요청의 초과 사용을 막습니다. 중단된 예약은 5분 뒤 다음 요청에서 해제합니다.
- `database/calorie-credits.sql`은 이미 생성한 테이블의 참고 정의입니다. 기존 테이블을 삭제하지 않습니다.
- `OPENAI_API_KEY`, `OPENAI_CALORIE_MODEL`(기본 gpt-6-luna), `TOSS_REWARDED_AD_GROUP_ID` 설정 후 재배포합니다. 광고 ID가 비어 있으면 조회/계산은 가능하지만 새 충전은 차단됩니다. 실제 비용과 정상 인증은 운영 설정 후 기기에서 검증해야 합니다.
- 테스트 광고는 **격리된 테스트 배포에서만** `TOSS_REWARDED_AD_GROUP_ID=ait-ad-test-rewarded-id`를 사용합니다. 운영 DB에 테스트 보상을 지급하지 마세요.

광고 SDK의 `userEarnedReward` 콜백에서만 complete를 호출하고, dismissed/취소는 보상을 주지 않습니다. 현재 연동 문서에 서명된 보상 영수증 검증 API가 없어, 서버는 실제 시청 자체를 독립적으로 증명하지 못합니다. 인증·세션 소유권·중복 지급·잔여 횟수 검사는 있지만 인증된 클라이언트가 complete를 조작하는 공격까지 막는 SSV는 아닙니다. 유료 공개 전에 광고 사업자의 서버 검증 지원 여부와 AI 프로젝트 지출 한도를 확인해야 합니다.

AI 호출은 `/v1/responses`의 구조화된 JSON 출력으로 제한합니다. 음식명만 전송하고 사용자 식별값은 보내지 않으며 `store: false`를 사용합니다. AI 결과는 추정치로 표시합니다. 실패는 원본 예외·키·음식명을 제외한 코드로 로그에 남깁니다. 오프라인 클라이언트 오류는 Storage 최대 20개 후 다음 인증 요청 시 업로드합니다.

공식 참고: https://developers.openai.com/api/docs/models/gpt-6-luna , https://developers.openai.com/api/docs/guides/structured-outputs , https://developers-apps-in-toss.toss.im/documentation/common/monetization/iaa/interstitial-rewarded-ad

## 기록 내보내기 광고 설정

`GET /api/ads`는 `TOSS_EXPORT_REWARDED_AD_GROUP_ID`만 공개 SDK 설정으로 반환합니다. ID 미설정 시 `exportRewardedAdGroupId: null`을 반환합니다. 기존 CORS 허용 Origin을 적용하고 캐시하지 않습니다. DB·사용자 인증·자동계산 횟수 지급과는 독립적입니다. API 키·인증서·DB 연결 정보는 응답에 포함하지 않습니다.

Vercel의 API 프로젝트에 내보내기용 보상형 광고 ID를 `TOSS_EXPORT_REWARDED_AD_GROUP_ID`로 설정한 뒤 재배포합니다. 보상 이름은 ‘기록 내보내기’, 수량은 1로 설정합니다. 기존 자동계산 보상 그룹(5회)과 구분합니다. 광고 ID가 없거나 설정 조회가 실패하면 미니앱은 기록 내보내기를 허용하지 않습니다.

미니앱은 `userEarnedReward`를 받은 후 광고가 닫히면 CSV를 저장하거나 프롬프트를 표시합니다. 출력은 기기 기록으로 생성하며 DB 테이블을 추가하거나 광고 보상을 서버에 기록하지 않습니다. 보상은 해당 화면의 선택 조건에만 적용되고, 조건 변경·화면 이탈 시 해제됩니다. 프롬프트가 표시된 후에는 다시 광고를 보지 않고 복사할 수 있습니다.
