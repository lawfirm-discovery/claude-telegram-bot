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
- **rtx6000 = 중앙 개발 서버**: 개발 서비스(Frontend, Spring, FastAPI)를 실행하는 유일한 서버
- **다른 서버(A4500, 3060 등)**: 코드 수정 & 푸시만 담당, 서비스 실행 및 빌드 금지
- **다른 서버 작업 절차**:
  1. `git pull origin dev-hs-rtx6000-new` — 최신 코드 가져오기
  2. 코드 수정 (타입체크/린트 수준만 확인, 빌드 실행 금지)
  3. `git push origin dev-hs-rtx6000-new` — rtx6000에 변경 전달
  4. rtx6000이 1분마다 자동 pull → 빌드·서비스 자동 반영
- **서비스 재시작 필요 시**: rtx6000 봇(@rtx6000_claude_style_bot)에게 요청
- **다른 서버에서 절대 금지**:
  - 서비스 실행: `pm2 start`, `systemctl start`, `bootRun`
  - Frontend 빌드: `npm run build`, `npx craco build`, `npx vite build`
  - Spring 빌드: `./gradlew build`, `./gradlew bootRun`, `./gradlew compileJava`
  - Flutter 빌드: `flutter build web`
  - 빌드는 rtx6000의 auto-pull이 자동 검증함. 에러 시 텔레그램 알림 발송
- **rtx6000 로컬 작업 시 반드시 push**: rtx6000에서 직접 코드를 수정·커밋한 경우 **즉시 push**할 것. auto-pull이 `--ff-only`로 동작하므로, unpushed 로컬 커밋이 남아있으면 다른 서버의 push를 pull할 수 없어 동기화가 멈춤

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

### 과도한 엔지니어링 금지 (Claude Code 시스템 규칙)
- **과도한 추상화 금지**: 1회성 작업에 helper/utility/wrapper 만들지 말 것. 비슷한 3줄 코드가 조기 추상화보다 낫다
- **불필요한 추가 금지**: 버그 수정에 주변 코드 정리 끼워넣지 말 것. 단순 기능에 과도한 설정 옵션 추가 금지. 변경하지 않은 코드에 docstring/주석/타입 어노테이션 추가 금지. 주석은 로직이 자명하지 않을 때만
- **불필요한 에러 핸들링 금지**: 일어날 수 없는 시나리오에 에러 처리/폴백/검증 넣지 말 것. 내부 코드와 프레임워크 보장을 신뢰할 것. 시스템 경계(사용자 입력, 외부 API)에서만 검증
- **호환성 핵 금지**: 안 쓰는 코드에 `_unused`, `// removed` 주석, re-export 등 넣지 말고 확실히 안 쓰면 그냥 삭제
- **파일 생성 최소화**: 새 파일 만들기보다 기존 파일 편집 선호. 꼭 필요할 때만 새 파일 생성

### API / 인터페이스
- 안정적 인터페이스 중심 설계
- 코드 경로 복제보다 optional 파라미터 추가
- 에러 시맨틱 일관성 유지

### 테스팅
- 버그를 잡았을 최소 테스트 추가
- 순수 로직 → unit, DB/네트워크 → integration, 핵심 플로우만 E2E
- 구현 세부사항에 묶인 깨지기 쉬운 테스트 지양

### 타입 안전
- `any`, ignore 억제 최소화
- 경계에서 검증, 산발적 체크 지양

### 의존성
- 기존 스택으로 해결 가능하면 새 의존성 추가 금지
- 표준 라이브러리 / 기존 유틸리티 우선

### 보안 & 프라이버시
- 코드, 로그, 채팅에 비밀 정보 노출 금지
- 사용자 입력 = 신뢰 불가 (검증, 소독, 제한)
- 최소 권한 원칙
- command injection, XSS, SQL injection 등 OWASP Top 10 취약점 주의. 보안 취약 코드 작성 시 즉시 수정

### 성능
- 조기 최적화 금지
- N+1, 무한 루프, 반복 중복 연산은 즉시 수정
- 의문이면 측정

---

## Git & 변경 관리

- 커밋은 원자적, 설명 가능하게 — "misc fixes" 금지
- 명시 요청 없이 히스토리 재작성 금지
- 포맷팅 변경과 동작 변경 분리
- 생성 파일은 프로젝트가 기대할 때만 커밋

### 커밋 & 푸시 절차 (필수)
1. **변경 확인**: `git diff` / `git status`로 의도한 변경만 포함 확인
2. **빌드 검증**: 해당 프로젝트의 빌드/컴파일 통과 확인
   - Spring: `./gradlew build` (또는 `bootRun` 정상 기동)
   - Frontend: `npm run build` 에러 없음
   - FastAPI: import 에러 없음
   - Flutter: `flutter build web` 통과
3. **린트/타입체크**: 프로젝트에 설정된 린터 실행
4. **테스트**: 관련 테스트 실행, 기존 테스트 깨지지 않음 확인
5. **커밋**: 관련 파일만 `git add` → 원자적 커밋 메시지
6. **푸시 판단**:
   - ✅ 에러 없음 → **바로 푸시** (사용자 확인 불필요)
   - ⚠️ 에러 발생 → **자동 수정 시도** → 수정 후 2~5번 재실행
   - ❌ 수정 불가 → **사용자에게 보고** (에러 내용 + 시도한 수정 + 제안)
7. **푸시 후**: 변경 요약 보고 (파일 수, 커밋 메시지, 브랜치)

---

## 완료 정의 (Definition of Done)

- 동작이 수락 기준과 일치
- 테스트/린트/타입체크/빌드 통과 (또는 미실행 사유 문서화)
- 위험한 변경은 롤백/플래그 전략 보유
- 기존 컨벤션 준수, 가독성 확보
- 검증 스토리 존재: "무엇이 변했고 + 어떻게 동작 확인했는지"

---

## 리걸몬스터 프로젝트 규칙

### 🚨 절대 규칙 (위반 금지)
- **`ddl-auto`는 반드시 `validate`** — 절대로 `update`로 변경 금지
- **포트 3000 사용 금지** — Docker open-webui 점유 중
- **JAR 빌드(`bootJar`) 금지** — `bootRun` 사용
- **세 레포 모두 `dev-hs-rtx6000-new` 브랜치** — 다른 브랜치 checkout 금지
- **Frontend: `craco`, `npm run build` 실행 금지** — Vite로 완전 마이그레이션됨. `craco build`, `npm run build`, `npx craco`는 레거시 CRA 빌드로 CPU 200%+ 점유하여 서버 장애 유발. 빌드 검증은 `npx vite build` 사용

### 🚨 웹-앱 동기화 규칙 (필수)
리걸몬스터 웹(`lemon-front`)과 Flutter 앱(`lemon_flutter`)은 **동일한 기능을 제공**해야 한다.
- **Frontend 수정 시**: 동일한 기능이 Flutter에도 존재하면 Flutter도 함께 수정
- **Flutter 수정 시**: 동일한 기능이 Frontend에도 존재하면 Frontend도 함께 수정
- **API 변경 시(Spring/FastAPI)**: 웹과 앱 양쪽의 호출부를 모두 확인하고 수정
- **대상 범위**: UI 동작, API 호출, 비즈니스 로직, 에러 처리, 데이터 표시 형식
- **제외**: 플랫폼 고유 기능(모바일 푸시 알림, 웹 전용 SEO 등)은 해당 플랫폼만 수정
- **작업 절차**: 웹 수정 → 웹 빌드 검증 → Flutter 동기화 수정 → Flutter 빌드 검증 → 양쪽 커밋 & 푸시

### 🚨 응답 필수 포함 (Response Footer) — 예외 없음!
리걸몬스터 관련 **모든** 응답 끝에 아래 2줄 필수:
```
---
🔗 테스트 서버: https://100.108.86.92:3011
📌 브랜치: `dev-hs-rtx6000-new`
```
- 작업 완료/진행 중/에러 상관없이 항상
- 간단한 질문 답변에도 항상

### 서버 & 환경
| 항목 | 값 |
|------|-----|
| 테스트 서버 | https://100.108.86.92:3011 |
| 기존 테섭 | https://test.legalmonster.co.kr |
| Flutter 웹 앱 | http://100.108.86.92:8088 |
| Spring | /home/angrylawyer/lemon-api-server-spring (systemd: lemon-spring-api) |
| Frontend | /home/angrylawyer/lemon-front (nginx가 `build/` static 서빙, 재빌드: pm2 `lemon-front-build` watch) |
| FastAPI | /home/angrylawyer/lemon-ai-server-FastAPI (pm2: lemon-fastapi) |
| Flutter | /home/angrylawyer/lemon_flutter |
| 작업 브랜치 | `dev-hs-rtx6000-new` (모든 저장소) |
| Config Vault | http://100.117.168.53:8070 (auth: `$CONFIG_VAULT_AUTH` env, 형식 `bot:비밀번호` — 평문 금지) |

### 빌드 & 실행
```bash
# Spring 반영 (올바른 방법): 직접 재시작 금지 — push 만 하면 됨
#   rtx6000 auto-pull 이 blue-green(8080/8081) 무중단 배포로 자동 반영 (1분 내).
#   ⛔ 'sudo systemctl restart lemon-spring-api[-green]' 직접 실행 금지 —
#      활성 슬롯 다운·여러 워커 동시 재시작 시 전면 502 (2026-07-15 하루 5회 동시다운 사고).
#      dangerous-cmd 훅이 비-rtx6000 봇에서 차단함.
#   강제 재시작이 꼭 필요하면 rtx6000 봇(@rtx6000_claude_style_bot)에게 요청.
# 로컬 컴파일 검증만: cd /home/angrylawyer/lemon-api-server-spring && LEMON_FORK_JAVAC=true ./gradlew --no-daemon compileJava

# Frontend — pm2 dev-server 없음. nginx가 build/를 직접 서빙.
# lemon-front-build (pm2)가 소스 변경 감지하여 자동 재빌드.
# 재빌드 강제 트리거가 필요한 경우만:
pm2 restart lemon-front-build

# FastAPI
pm2 restart lemon-fastapi

# Flutter 웹 빌드 (~100초)
cd /home/angrylawyer/lemon_flutter && /home/angrylawyer/flutter/bin/flutter build web --release --no-wasm-dry-run
```

### Gradle 빌드 환경변수
```bash
LEMON_FORK_JAVAC=true LEMON_JAVAC_XMX=24g
```

### Frontend 빌드 메모리
```bash
NODE_OPTIONS=--max-old-space-size=102400
```

### nginx 설정 (3011 = HTTPS 전용, 자체서명 인증서 → curl은 `-k` 필수)
| 경로 | 대상 |
|------|------|
| :3011/ → | static: `/home/angrylawyer/lemon-front/build/` (try_files → index.html) |
| :3011/api → | localhost:8080 (Spring) |
| :3011/ws/ → | localhost:8080 (WebSocket) |
| :3011/api/ai-chat/ → | localhost:8080 (SSE 스트리밍) |
| :3011/api/org-chat/, /api/cowork → | localhost:8001 (FastAPI) |
| :3011/globallaw-api/ → | 100.117.168.53:8090 |

### 표준 포트 (변경 금지!)
| 서비스 | 포트 |
|--------|------|
| nginx 외부 | 3011 (HTTPS) |
| Spring | 8080 |
| FastAPI | 8001 |
| Docker open-webui | 3000 (사용 금지!) |
> Frontend는 별도 dev-server 포트를 사용하지 않음 (nginx가 정적 파일 직접 서빙). 하트비트 체크 시 반드시 `https://…:3011` + `curl -k`.

### 브랜치 & Pull 소스
| 저장소 | 작업 브랜치 | pull 소스 |
|--------|------------|-----------|
| FastAPI | `dev-hs-rtx6000-new` | `master` |
| Frontend | `dev-hs-rtx6000-new` | `dev` |
| Spring | `dev-hs-rtx6000-new` | `dev` |

### Dev Mode 실시간 반영
- 크론: `* * * * *` (1분마다 git pull)
- 스크립트: `/home/angrylawyer/auto-pull-reload.sh`
- Frontend: HMR / Spring: DevTools 자동 리로드 / FastAPI: --reload 자동 반영
- Flutter: 수동 빌드 필요

### Spring .env 형식 주의
- 멀티라인 값 (NAVER_WORKS_PRIVATE_KEY 등): 반드시 `\n`으로 한 줄 처리
- 잘못된 형식 → 서비스 크래시 루프

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
- `pb` 중복 적용 금지! 상위에서 적용 시 하위에서 추가 X
- 방법: `height: calc(100vh - 64px - 50px)` 또는 `flex: 1` + `pb: { xs: 8, md: 2 }`

### 드롭다운 / 셀렉터
- **네이티브 `<select>` 사용 금지** — 반드시 `CustomSelect` 컴포넌트 사용
- `CustomSelect` 경로: `src/components/CustomSelect.tsx` (history-timeline 프로젝트)
- 아이콘 + 라벨, 선택 시 체크마크, 다크모드 대응, z-index 50
- size: `sm` (폼 내) / `md` (독립 필터)

### 모바일 UX (필수 체크)
- 모든 UI 변경 시 **모바일 뷰포트(375px)에서 가독성 및 터치 영역** 반드시 확인
- 터치 타겟 최소 44px (버튼, 링크, 탭)
- 긴 텍스트: `truncate` 또는 `line-clamp` 적용
- 가로 스크롤 방지: `overflow-x-hidden` 또는 `flex-wrap`
- 모달/패널: 모바일에서 전체 너비 또는 최소 90vw
- 폰트: 모바일 최소 11px (`text-[11px]`), 본문 최소 13px

### 작업 전 필수 확인
- [ ] 모달 backdrop blur?
- [ ] 모달 모바일 전체화면?
- [ ] 모바일 글자/패딩 최적화?
- [ ] 본문이 채팅 레일까지 꽉 참?
- [ ] 모달 z-index 문제 없음?
- [ ] 드롭다운: CustomSelect 사용?
- [ ] 모바일 375px에서 가독성 확인?
- [ ] 터치 타겟 44px 이상?

---

## Config Vault (API 키 저장소)

```bash
# 값 조회
curl -u "$CONFIG_VAULT_AUTH" http://100.117.168.53:8070/api/value/KEY_NAME

# 서버별 환경변수
curl -u "$CONFIG_VAULT_AUTH" http://100.117.168.53:8070/api/env/SERVER_NAME

# 새 키 저장
curl -u "$CONFIG_VAULT_AUTH" -X POST "http://100.117.168.53:8070/api/configs/MY_KEY?value=xxx&category=AI"
```

---

## 안전 수칙

- 비밀 데이터 외부 유출 금지
- 파괴적 명령 실행 전 확인 (`rm` 대신 `trash` 선호)
- 이메일, 트윗, 공개 포스트 등 외부 행동은 먼저 확인
- 불확실하면 물어보기

### 위험한 작업 신중히 (Claude Code 시스템 규칙)
되돌리기 어렵거나 공유 시스템에 영향을 주는 작업은 **반드시 사용자 확인 후 실행**:
- **파괴적 작업**: 파일/브랜치 삭제, DB 테이블 drop, 프로세스 kill, rm -rf, 커밋되지 않은 변경 덮어쓰기
- **되돌리기 어려운 작업**: force-push, git reset --hard, published commit 수정, 패키지 제거/다운그레이드, CI/CD 파이프라인 수정
- **다른 사람에게 보이는 작업**: 코드 push, PR/이슈 생성·닫기·코멘트, Slack/이메일/GitHub 메시지 전송, 외부 서비스 포스팅, 공유 인프라/권한 수정

**장애물을 만나면 파괴적 방법으로 해결하지 말 것:**
- 안전 검사를 우회(`--no-verify` 등)하지 말고 근본 원인을 파악
- 모르는 파일/브랜치/설정은 삭제 전 조사 (사용자의 작업중인 것일 수 있음)
- 머지 충돌은 변경사항 폐기보다 해결 우선
- 락 파일은 삭제 전 점유 프로세스 확인
- **한 번 승인받았다고 모든 상황에서 승인된 것 아님** — 매번 컨텍스트 판단

### 도구 사용 규칙 (Claude Code 시스템 규칙)
- 파일 읽기: `cat`/`head`/`tail`/`sed` 대신 **Read 도구** 사용
- 파일 편집: `sed`/`awk` 대신 **Edit 도구** 사용
- 접근이 막힌 경우 brute force 금지 — 대안을 찾거나 사용자에게 질문

---

## 🚨 리걸몬스터 공통 작업 규칙 (경로 무관 절대 준수 — 2026-05-19)

> 웹/Flutter/Spring/FastAPI 전 레포 CLAUDE.md + `~/.claude/CLAUDE.md` 에 동일 반영. 정본: `claude-telegram-bot/CLAUDE.md.template`.

1. **설계 시 기존 코드베이스 충분 검토 (무작정 신규 생성 금지)**: 새 기능·수정 전 `lemon-front`·`lemon_flutter`·Spring·FastAPI의 기존 기능·엔드포인트·데이터모델·컴포넌트를 먼저 조사. 새로 만들지 말고 기존 기능과 연결·재사용·확장. 유사 기능 있으면 중복 구현 금지.
2. **파일 비대화 방지 / 컴포넌트 분리 (우선순위)**: 단일 파일이 과도하게 커지지 않게 하위 컴포넌트·로직을 의미 단위로 분리하고 폴더 구조로 정리. 비대 파일은 분할 리팩토링 우선. 단 사소 변경/조기 분해/1회성 wrapper 남발은 예외(최소변경·과도엔지니어링 규칙 우선).
3. **ERP 사이드바: v1=deprecated, v2(신규 DB 구조)=실제 활성**. 메뉴 추가·변경·라우팅은 v2 DB 구조 기반. v1 수정·확장 금지 — 작업 전 v1/v2 확인.
4. **DB 작업 (Flyway 없음)**: 자격증명은 문서/채팅/git/로그에 절대 평문 기재 금지 — rtx6000 `lemon-api-server-spring/.env.development` 런타임 로드(워커는 Tailscale SSH 경유). 모든 변경은 `BEGIN; … 검증 SELECT … COMMIT;` 트랜잭션. **새 테이블: 기존 prefix 컨벤션 검증(provider별 `payment_<provider>_*`, 단독 provider prefix 금지) + 반드시 호성님(@legalmonster) 보고 후 진행** — 자동 진행 금지. `ddl-auto=validate`, `update` 절대 금지.
5. **🌐 브라우저 테스트 — Playwright MCP 표준 (2026-05-21, 2026-05-22 모바일 의무)**: 브라우저 자동화·E2E·스크린샷은 **Playwright MCP 만 사용** (`mcp__playwright__browser_*`). 직접 playwright/puppeteer 스크립트 작성 금지(기존 운영 코드 예외). 테스트 계정은 **`$TEST_ACCOUNT_EMAIL` / `$TEST_ACCOUNT_PASSWORD` 환경변수**만 — 평문 코드/문서/로그/채팅 노출 금지. 출처: `~/.claude/test-accounts.env` (mode 600). 누락 시 작업 중단·호성님 보고. **실서비스 사용자 계정 사용 금지** — 운영 데이터 사이드 이펙트 회피. Config Vault 인증은 `$CONFIG_VAULT_AUTH` env (형식 `bot:비밀번호`, `~/.claude/config-vault.env`, mode 600). **🚨 모바일 UX·모바일 전용 기능도 반드시 함께 테스트** — `mcp__playwright__browser_resize({width:375,height:667})`로 모바일 viewport도 동일 시나리오 반복. 터치 타겟 44px+, 풀스크린 모달, FAB/햄버거 메뉴/swipe 등 모바일 전용 동작 검증. 데스크탑만 확인된 보고는 미완료로 간주. `/sync feat/orchestrator` 가 워커들에 자동 배포.
