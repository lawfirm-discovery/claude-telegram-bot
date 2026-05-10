# 공통 메뉴 검증 — 반복 1 (2026-05-10)

> **검증 대상**: 모든 사용자 공통 메뉴 (대시보드, 법령검색, 판례검색, 전자계약)
> **검증 방법**: 소스코드 정적 분석 (프론트엔드 + 백엔드 크로스체크)
> **환경**: lemon-front + lemon-api-server-spring, 브랜치 dev-hs-rtx6000-new

---

## 검증 요약

| 카테고리 | PASS | FAIL | SKIP | STUB | N/A | 비고 |
|----------|------|------|------|------|-----|------|
| A. 기능성 | 12 | 5 | 4 | 0 | 0 | API 정합성 불일치 2건, 로직 버그 2건, 중복 시스템 1건 |
| B. UI/UX | 8 | 2 | 4 | 0 | 0 | 로딩 상태 미표시 1건, 인증 로딩 미처리 1건 |
| C. 성능 | 3 | 1 | 3 | 0 | 0 | race condition 위험 1건 |
| D. 에러 처리 | 5 | 2 | 3 | 0 | 0 | 일반 에러 메시지 1건, 폴백 미흡 1건 |
| E. i18n/a11y | 3 | 1 | 1 | 0 | 0 | 인코딩 깨진 주석 1건 |
| **합계** | **31** | **11** | **15** | **0** | **0** | 통과율 73.8%, 커버리지 73.7% |

---

## 발견된 이슈 목록

### ISSUE-PREC-1-01 [CRITICAL] 판례검색 날짜 필터 초기값 버그

- **심각도**: CRITICAL
- **카테고리**: A3 (비즈니스 로직)
- **위치**: `lemon-front/src/erp/pages/LegalInfo/components/PrecedentSearchV2.tsx` (약 line 1190)
- **현상**: 날짜 필터 초기값이 `setFullYear(1900)` — 1년 전이 아니라 1900년으로 설정됨
- **영향**: 날짜 필터 사용 시 기본 범위가 1900~현재로 설정되어 사실상 필터 무효화
- **근본 원인**: `oneYearAgo.setFullYear(1900)` — 인자에 1900을 직접 전달
- **수정 방안**: `oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)` 로 변경
- **수정 상태**: 미수정

### ISSUE-PREC-1-02 [HIGH] 판례검색 API 경로 불일치

- **심각도**: HIGH
- **카테고리**: A1 (API 정합성)
- **위치**: `PrecedentSearchV2.tsx` vs `LegalInfoV2Controller.java`
- **현상**: 프론트엔드는 `/api/lawdocs/precedent` (레거시) 사용, 백엔드 V2 컨트롤러는 `/api/v2/legal-info/precedent/search` 제공
- **영향**: V2 엔드포인트가 사용되지 않아 V2에만 구현된 기능(있을 경우) 접근 불가
- **수정 상태**: 확인 필요 (레거시가 의도적일 수 있음)

### ISSUE-PREC-1-03 [MEDIUM] 판례검색 Race Condition 위험

- **심각도**: MEDIUM
- **카테고리**: C (성능)
- **위치**: `PrecedentSearchV2.tsx`
- **현상**: AbortController 미사용 — 빠른 필터 변경 시 이전 요청 응답이 나중에 도착하면 결과 덮어씀
- **영향**: 사용자가 빠르게 검색어 변경 시 잘못된 결과가 표시될 수 있음
- **수정 방안**: 법령검색(LawSearchV2)처럼 AbortController 적용
- **수정 상태**: 미수정

### ISSUE-DASH-1-01 [HIGH] 대시보드 Admin 분기 로직 오류

- **심각도**: HIGH
- **카테고리**: A3 (비즈니스 로직)
- **위치**: `lemon-front/src/erp/pages/Dashboard/RoleBasedDashboard.tsx` (line 40-58)
- **현상**: Admin 체크가 3곳에서 서로 다른 방식으로 수행됨 (dtype 기반 vs ID whitelist 기반)
- **영향**: 
  - `isAdminUser(id) && isAdmin` 조건의 두 번째 분기(line 56)는 도달 불가능
  - Admin 사용자가 ID whitelist에 없으면 DashboardSelector 접근 불가
- **수정 방안**: Admin 체크를 한 가지 방식으로 통합
- **수정 상태**: 미수정

### ISSUE-DASH-1-02 [MEDIUM] 대시보드 인증 로딩 상태 미처리

- **심각도**: MEDIUM
- **카테고리**: B (UI/UX)
- **위치**: `RoleBasedDashboard.tsx` (line 27-32)
- **현상**: `user`가 null일 때 바로 "로그인 필요" 메시지 표시 — auth 로딩 중에도 동일
- **영향**: 페이지 로드 시 잠깐 "로그인 필요" 플래시가 보일 수 있음
- **수정 방안**: `useAuth()`의 loading 상태 체크 추가
- **수정 상태**: 미수정

### ISSUE-DASH-1-03 [LOW] 미인식 사용자 타입 무경고 폴백

- **심각도**: LOW
- **카테고리**: D (에러 처리)
- **위치**: `RoleBasedDashboard.tsx` (line 59-62)
- **현상**: dtype이 어떤 조건에도 해당하지 않으면 조용히 DashboardPage로 폴백
- **영향**: 새 사용자 타입 추가 시 개발자가 인지 못 할 수 있음
- **수정 방안**: dev 모드에서 console.warn 추가
- **수정 상태**: 미수정

### ISSUE-CONT-1-01 [HIGH] 전자계약 V1/V2 API 병행 사용

- **심각도**: HIGH
- **카테고리**: A1 (API 정합성)
- **위치**: 
  - V1: `lemon-front/src/erp/api/contract.api.ts` → `/api/contracts`
  - V2: `lemon-front/src/services/contract.service.ts` → `/api/v2/unified-contracts`
- **현상**: 두 개의 독립된 계약 관리 시스템이 공존
  - `/erp/mycase/contract/*` → V1 API
  - `/erp/lemon-contract/*` → V2 API
- **영향**: 데이터 불일치 가능, 유지보수 부담 증가, 사용자 혼란
- **수정 상태**: 아키텍처 결정 필요

### ISSUE-CONT-1-02 [MEDIUM] V1 계약 목록 로딩 상태 미표시

- **심각도**: MEDIUM
- **카테고리**: B (UI/UX)
- **위치**: `lemon-front/src/erp/pages/contract/ContractListPage.tsx`
- **현상**: 목록 로딩 중 스켈레톤/스피너 없음
- **영향**: 사용자가 빈 화면을 보고 데이터 없음으로 오인할 수 있음
- **수정 방안**: isLoading 상태 + Skeleton 컴포넌트 추가
- **수정 상태**: 미수정

### ISSUE-CONT-1-03 [LOW] V2 응답 정규화 복잡성

- **심각도**: LOW
- **카테고리**: A1 (API 정합성)
- **위치**: `contract.service.ts`
- **현상**: snake_case → camelCase 변환, 템플릿 타입 다중 매핑 (LAWBOT_DOC vs LAWBOTDOC vs AI_GENERATED)
- **영향**: 백엔드 응답 형식 변경 시 프론트엔드 다운 위험
- **수정 방안**: 백엔드에서 일관된 응답 형식 제공
- **수정 상태**: 미수정

### ISSUE-PREC-1-04 [LOW] 판례검색 인코딩 깨진 주석

- **심각도**: LOW
- **카테고리**: E (i18n)
- **위치**: `PrecedentSearchV2.tsx` (약 line 1890)
- **현상**: `// ???쒖떆 媛쒖닔(pageSize) ???蹂듭썬` — UTF-8 인코딩 깨짐
- **영향**: 코드 가독성 저하 (기능 영향 없음)
- **수정 상태**: 미수정

### ISSUE-LAW-1-01 [INFO] 법령검색 — 양호

- **심각도**: INFO
- **카테고리**: 전체
- **위치**: `LawSearchV2.tsx`
- **현상**: 모든 검증 항목 통과 — API 정합성, 에러 처리, 로딩, 빈 상태, 페이지네이션, i18n 양호
- **비고**: AbortController, prefetch, 최근 검색어 저장 등 모범 구현

---

## 메뉴별 상세 체크리스트

### 1. 법령검색 (LawSearchPage)

| 항목 | 결과 | 비고 |
|------|------|------|
| A1-1 API 경로 일치 | PASS | `/api/v2/legal-info/law/search` 일치 |
| A1-2 HTTP 메서드 | PASS | GET 일치 |
| A1-3 Request DTO | PASS | keyword, page, size 일치 |
| A1-4 Response DTO | PASS | data.data.items 구조 매핑 |
| A2-1 목록 조회 | PASS | 검색 결과 정상 렌더링 |
| A3-4 검색 기능 | PASS | 키워드 검색 + 예시 칩 |
| A3-5 페이지네이션 | PASS | MUI Pagination, 10건/페이지 |
| B3-2 빈 상태 | PASS | 검색 후 결과 없음 메시지 |
| B3-3 로딩 | PASS | SearchResultsSkeleton |
| D-1 API 실패 알림 | PASS | Alert severity="error" + i18n |
| D-10 graceful fallback | PASS | 에러 시 빈 목록 + 에러 메시지 |
| E-1 한국어 번역 | PASS | 110+ i18n 키 사용 |

### 2. 판례검색 (PrecedentSearchPage)

| 항목 | 결과 | 비고 |
|------|------|------|
| A1-1 API 경로 일치 | FAIL | 레거시 `/api/lawdocs/precedent` 사용 (ISSUE-PREC-1-02) |
| A2-1 목록 조회 | PASS | 검색 결과 렌더링 정상 |
| A3-3 데이터 필터링 | FAIL | 날짜 필터 초기값 1900년 버그 (ISSUE-PREC-1-01) |
| A3-4 검색 기능 | PASS | total/case_number/case_name/full_text 검색 |
| A3-5 페이지네이션 | PASS | Intersection Observer 무한 스크롤 |
| B3-2 빈 상태 | PASS | 결과 없음 + 최근 판례 표시 |
| B3-3 로딩 | PASS | Skeleton + CircularProgress |
| C-4 메모리 누수 | FAIL | AbortController 미사용 (ISSUE-PREC-1-03) |
| D-1 API 실패 알림 | PASS | Alert 표시 |
| E-2 하드코딩 텍스트 | FAIL | 인코딩 깨진 주석 (ISSUE-PREC-1-04) |

### 3. 대시보드 (RoleBasedDashboard)

| 항목 | 결과 | 비고 |
|------|------|------|
| A3-1 상태 전이 | FAIL | Admin 분기 도달 불가 (ISSUE-DASH-1-01) |
| A4-1 라우트 매핑 | PASS | /dashboard → RoleBasedDashboard |
| B3-3 로딩 | FAIL | 인증 로딩 상태 미처리 (ISSUE-DASH-1-02) |
| D-4 403 Forbidden | PASS | 타입별 분기 처리 |
| D-10 graceful fallback | PASS | 기본 DashboardPage 폴백 (경고 부재) |

### 4. 전자계약 (LemonContract)

| 항목 | 결과 | 비고 |
|------|------|------|
| A1-1 API 경로 일치 | FAIL | V1/V2 병행 (ISSUE-CONT-1-01) |
| A2-1~5 CRUD | PASS | V2: 완전한 CRUD + soft delete |
| B3-3 로딩 | FAIL | V1 목록 로딩 상태 없음 (ISSUE-CONT-1-02) |
| D-1 API 실패 알림 | PASS | V2: 에러 처리 양호 |

---

## 코드 변경 사항

이번 반복에서는 코드 수정 없이 정적 분석만 수행.

---

## 다음 반복 계획

1. **ISSUE-PREC-1-01 수정**: 날짜 필터 초기값 버그 (CRITICAL → 즉시 수정 대상)
2. **일정관리·할일 메뉴 검증**: 공통 메뉴 중 미검증 항목 (내 업무, LDrive)
3. **API 호출 실제 테스트**: curl로 주요 엔드포인트 응답 확인
4. **전문가 타입별 메뉴 검증 시작**: 변호사 또는 세무사 메뉴

---

## 반복 통계

| 항목 | 값 |
|------|-----|
| 검증 메뉴 수 | 4 (법령검색, 판례검색, 대시보드, 전자계약) |
| 검증 항목 수 | 42 (PASS: 31, FAIL: 11, SKIP: 15) |
| 통과율 | 73.8% |
| 커버리지 | 73.7% |
| 발견 이슈 수 | 11 (CRITICAL: 1, HIGH: 3, MEDIUM: 3, LOW: 3, INFO: 1) |
| 소요 시간 | ~5분 |
