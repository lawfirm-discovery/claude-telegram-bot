# Claude Code 글로벌 규칙

## 사용자 정보

- **이름:** 천호성 (Hosung Chun)
- **호칭:** 호성
- **타임존:** Asia/Seoul (GMT+9)
- **Telegram:** @legalmonster

---

## 핵심 원칙

- **정확성 > 창의성**: 읽기 쉽고 유지보수 쉬운 솔루션 우선
- **최소 변경 원칙**: 필요한 만큼만 변경, 인접 코드 리팩토링 자제
- **기존 패턴 따르기**: 새 추상화/의존성 도입 전 프로젝트 컨벤션 우선
- **검증 필수**: "될 것 같다"는 안 됨. 테스트/빌드/린트로 증명
- **불확실하면 명시**: 검증 못 한 부분은 솔직히 말하고 안전한 다음 단계 제안
- **수정 전 반드시 읽기**: 코드를 읽지 않고 수정 제안 금지. 기존 코드를 먼저 이해할 것
- **야심찬 작업 허용**: 사용자가 요청한 큰 작업을 거부하지 말 것. 범위 판단은 사용자에게 위임

---

## 응답 스타일

- **간결하고 핵심적으로** — 결과와 영향 먼저, 프로세스 설명 나중에
- **구체적 참조** — 파일 경로, 명령어, 에러 메시지 포함
- **대량 로그 금지** — 요약 후 증거 위치 안내
- **질문은 정말 막혔을 때만** — 하나만, 추천 기본값과 함께
- **링크는 항상 클릭 가능하게** — URL에 꺾쇠(`<>`) 금지

---

## 작업 흐름

### 🚨 설계 → 승인 → 구현 (필수 프로세스)
1. **설계**: 작업 요청 받으면 먼저 변경 범위, 영향 파일, 접근 방식을 설계
2. **사용자 승인**: 설계안을 사용자에게 제시하고 **승인을 받은 후에만** 코드 수정 시작
3. **구현**: 승인된 설계대로 구현
4. **검증**: 빌드/린트/테스트 통과 확인
5. **커밋 & 푸시**: 검증 통과 후 커밋 & 푸시 (에러 시 자동 수정 시도)
- 단순 수정(오타, 1줄 변경, 명확한 버그픽스)은 바로 구현 가능
- 3단계 이상, 멀티파일, 아키텍처 결정 작업은 반드시 Plan Mode 사용
- 새 정보가 계획을 무효화하면 → 중단, 계획 업데이트 후 재개

### 멀티서버 작업 규칙
- **맥미니 M4 = 중앙 개발/서비스 서버**: 프론트엔드(React+Vite) + 백엔드(FastAPI+uvicorn)를 실행하는 유일한 서버
- **n100**: DB 서버(PostgreSQL) + 크롤러 서버. 코드 수정 시 맥미니에 SSH로 접속하여 작업
- **n100에서 맥미니 작업 절차**:
  1. `ssh pylon@100.88.75.47` — 맥미니 접속
  2. `/Users/pylon/my_project_v3/`에서 코드 수정
  3. 커밋 & 푸시
- **서비스 재시작 필요 시**: 맥미니에서 직접 실행
  - 프론트엔드: `cd /Users/pylon/my_project_v3/frontend && npm run build`
  - 서버: `cd /Users/pylon/my_project_v3 && nohup ./start.sh > backend_start.log 2>&1 &`

### 점진적 작업 (리스크 최소화)
- 얇은 수직 슬라이스 선호
- 구현 → 테스트 → 검증 → 확장 순서
- 가능하면 feature flag, config 스위치, 안전 기본값 뒤에 숨기기

### 검증 후 완료
- 증거 없이 완료 선언 금지
- 테스트, 린트, 타입체크, 빌드, 로그 또는 수동 재현
- 기준: "시니어 엔지니어가 이 diff와 검증을 승인할까?"

---

## 에러 처리 & 복구

### Stop-the-Line 규칙
예상치 못한 상황(테스트 실패, 빌드 에러, 동작 변경) 발생 시:
1. 기능 추가 중단
2. 증거 보존 (에러 출력, 재현 단계)
3. 진단 후 재계획

### 트리아지 순서
1. 재현 → 2. 실패 계층 파악 → 3. 최소 실패 케이스 → 4. 근본 원인 수정 → 5. 회귀 방지 → 6. E2E 검증

### 안전 폴백
- "안전 기본값 + 경고" > 부분 동작
- 조용한 실패 대신 actionable 에러 반환
- 광범위 리팩토링을 "수정"으로 위장 금지

---

## 엔지니어링 모범 사례

### 과도한 엔지니어링 금지
- **과도한 추상화 금지**: 1회성 작업에 helper/utility/wrapper 만들지 말 것
- **불필요한 추가 금지**: 버그 수정에 주변 코드 정리 끼워넣지 말 것
- **불필요한 에러 핸들링 금지**: 일어날 수 없는 시나리오에 에러 처리 넣지 말 것
- **호환성 핵 금지**: 안 쓰는 코드는 그냥 삭제
- **파일 생성 최소화**: 새 파일 만들기보다 기존 파일 편집 선호

### API / 인터페이스
- 안정적 인터페이스 중심 설계
- 코드 경로 복제보다 optional 파라미터 추가
- 에러 시맨틱 일관성 유지

### 테스팅
- 버그를 잡았을 최소 테스트 추가
- 순수 로직 → unit, DB/네트워크 → integration, 핵심 플로우만 E2E

### 보안 & 프라이버시
- 코드, 로그, 채팅에 비밀 정보 노출 금지
- 사용자 입력 = 신뢰 불가
- 최소 권한 원칙

---

## Git & 변경 관리

- 커밋은 원자적, 설명 가능하게
- 명시 요청 없이 히스토리 재작성 금지
- 포맷팅 변경과 동작 변경 분리

### 커밋 & 푸시 절차 (필수)
1. `git diff` / `git status`로 의도한 변경만 포함 확인
2. 빌드 검증
3. 린트/타입체크
4. 테스트
5. 관련 파일만 `git add` → 원자적 커밋 메시지
6. 에러 없음 → 바로 푸시 / 에러 → 자동 수정 시도 / 수정 불가 → 보고
7. 푸시 후 변경 요약 보고

---

## 프로젝트 규칙 (맥미니 M4 my_project_v3)

### 🚨 절대 규칙 (위반 금지)
- **프로젝트는 반드시 `/Users/pylon/my_project_v3/`에서 작업** — v2 절대 금지
- **포트 8888 = uvicorn** — 변경 금지

### 서버 & 환경
| 항목 | 값 |
|------|-----|
| 맥미니 M4 | Tailscale IP: 100.88.75.47 |
| 프로젝트 경로 | `/Users/pylon/my_project_v3/` |
| 프론트엔드 | `frontend/` (React + Vite + TypeScript) |
| 백엔드 | `backend/` (FastAPI + Python 3.14) |
| uvicorn 포트 | 8888 (API + 정적파일 서빙) |
| n100 DB | PostgreSQL 100.65.20.81:5432 (pylon/415416) |
| Config Vault | http://100.117.168.53:8070 (bot:lemon2024!) |

### 빌드 & 실행 (맥미니에서)
```bash
# 프론트엔드 빌드 (빌드만 하면 재시작 불필요)
cd /Users/pylon/my_project_v3/frontend && npm run build

# 서버 재시작
cd /Users/pylon/my_project_v3 && nohup ./start.sh > backend_start.log 2>&1 &
```

### Config Vault (API 키 저장소)
```bash
# 값 조회
curl -u "bot:lemon2024!" http://100.117.168.53:8070/api/value/KEY_NAME

# 서버별 환경변수
curl -u "bot:lemon2024!" http://100.117.168.53:8070/api/env/SERVER_NAME
```

---

## UI/UX 작업 체크리스트

### 모달
- 데스크탑: backdrop blur (`backdropFilter: 'blur(4px)'`)
- 모바일: 전체화면 (`fullScreen={isMobile}`)
- z-index 문제 시: `createPortal` + `zIndex: 1400`

### 반응형
- 글자: `fontSize: { xs: '0.875rem', md: '1rem' }`
- 패딩: `p: { xs: 1, sm: 1.5, md: 2 }`
- 테이블: `whiteSpace: 'nowrap'` + `minWidth`

### 페이지 높이
- 채팅 레일 높이: 50px (`ERP_BOTTOM_CHAT_RAIL_HEIGHT_PX`)
- `pb` 중복 적용 금지
- 방법: `height: calc(100vh - 64px - 50px)` 또는 `flex: 1` + `pb: { xs: 8, md: 2 }`

---

## 안전 수칙

- 비밀 데이터 외부 유출 금지
- 파괴적 명령 실행 전 확인
- 불확실하면 물어보기

---

## n100 코딩 봇 규칙

### 토큰 절약 5가지 규칙
1. 이미 읽은 파일은 다시 읽지 않기
2. 컨텍스트에 있는 정보는 툴 없이 답변
3. 독립적인 툴 콜은 병렬 실행
4. 결과가 클 경우 서브에이전트에 위임
5. 사용자가 설명한 내용 반복 금지

### 응답 스타일
- 짧고 직관적으로
- 코드 변경 시 diff 형태로 핵심만
- 불필요한 설명 없이 바로 실행
- Telegram에서 작업 시작 시 즉시 reply로 "⏳ 처리 중..." 메시지 먼저 보내고, 완료 시 새 reply 전송 (push 알림 발생)

### 작업 원칙
- 파일 읽기 전 필요한 부분만 타겟 검색
- 에러는 원인 분석 후 최소 변경으로 수정
- 추가 기능 요청 없으면 범위 확장 금지

### 인프라 구조

#### 맥미니 M4 (앱 서버 + 개발 환경)
- Tailscale IP: 100.88.75.47
- 사용자: pylon / 홈: /Users/pylon/
- 프로젝트: /Users/pylon/my_project_v3/ ← **유일한 실서비스 버전. 항상 v3만 수정할 것**
  - ⚠️ /Users/pylon/my_project_v2/ 는 절대 건드리지 말 것 (구버전, 미사용)
  - 프론트엔드: frontend/ (React + Vite + TypeScript)
  - 백엔드: backend/ (FastAPI + Python 3.14)
- 실행: uvicorn 포트 8888
  - 백엔드 API + frontend/dist/ 정적파일 동시 서빙
  - SPA fallback: API 아닌 GET 요청 → index.html 반환
- 배포:
  - 프론트엔드: `cd /Users/pylon/my_project_v3/frontend && npm run build`
  - 서버 재시작: `cd /Users/pylon/my_project_v3 && nohup ./start.sh > backend_start.log 2>&1 &`
  - 프론트는 빌드만 하면 재시작 불필요
- 주요 도구: Node.js v25.6.1 / npm 11.9.0 / Python 3.14 / Bun 1.3.11

#### n100 (DB 서버 + 크롤러 서버)
- Tailscale IP: 100.65.20.81
- SSH: `ssh pylon@100.65.20.81`
- sudo 비밀번호: vmfhrmfoa2@
- DB (PostgreSQL): 포트 5432 / DB명: pylon / user: pylon / PW: 415416
- 크롤러 경로: /home/pylon/Crawlers/

#### 데이터 흐름
크롤러(n100) → n100 PostgreSQL → 맥미니 uvicorn 백엔드 조회 → 프론트엔드 표시

### 🚨 맥미니 긴급 복구 공식

맥미니가 빌드 과부하/Tailscale 끊김으로 응답 없을 때 N100 경유 복구:

**1단계: N100에서 맥미니 내부 IP 확인**
```bash
ssh pylon@100.65.20.81 "arp -a"
```

**2단계: N100 점프 호스트로 맥미니 접속 (비밀번호: 147800)**
```bash
ssh -J pylon@100.65.20.81 pylon@192.168.0.70
```

**3단계: 맥미니에서 서비스 복구**
```bash
# Tailscale 강제 활성화
echo '147800' | sudo -S tailscale up --accept-routes

# 프로세스 정리 및 재시작
pkill -9 -f uvicorn
pkill -9 -f start.sh
pkill -9 -f uvicorn; pkill -9 -f start.sh
cd ~/my_project_v3 && nohup ./start.sh > backend_start.log 2>&1 &
```

---

## Bun 프로젝트 규칙

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
