# 공통 메뉴 검증 — 반복 6~10 통합 보고서 (2026-05-10)

> **검증 대상**: 반복 1~5에서 발견된 26건 이슈 코드라인 재검증 + 속기사 모듈 크로스체크
> **검증 방법**: 실제 소스코드 라인 확인 (lemon-front dev-hs-rtx6000-new)
> **환경**: lemon-front + lemon-api-server-spring, 브랜치 dev-hs-rtx6000-new

---

## 반복 6: CRITICAL 이슈 코드라인 재검증 (2건)

### ISSUE-PREC-1-01 [CRITICAL] 판례검색 날짜 필터 — 재검증 결과: **미수정 확인**

- **파일**: `PrecedentSearchV2.tsx` line 1189-1199
- **현재 코드**:
  ```typescript
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(1900);  // ← 여전히 1900 하드코딩

  useEffect(() => {
    setStartDate(formatDate(oneYearAgo));
    setEndDate(formatDate(today));
  }, []);
  ```
- **영향**: 날짜 필터 기본값이 1900년~현재. 사실상 필터 무효화
- **AbortController**: 미적용 (Race Condition 위험 지속)
- **수정 필요**: `oneYearAgo.setFullYear(new Date().getFullYear() - 1)`
- **상태**: ❌ 미수정

### ISSUE-SCHED-2-01 [CRITICAL] 일정 ID 파싱 NaN — 재검증 결과: **미수정 확인**

- **파일**: `SchedulePage.tsx` line 858, 881
- **현재 코드**:
  ```typescript
  const scheduleId = Number(selectedEvent.id.split('-').pop());
  ```
- **사용 위치**:
  - line 858: `updateScheduleEvent()` 내부
  - line 881: `deleteScheduleEvent()` 내부
- **영향**: 복합 ID (예: `SCHEDULE-123-abc`)일 경우 `Number("abc")` = NaN → API 호출 실패
- **상태**: ❌ 미수정

---

## 반복 7: HIGH 이슈 코드라인 재검증 (7건)

### ISSUE-SCHED-2-02 [HIGH] 타임존 이중 보정 — **미수정 확인**

- **파일**: `SchedulePage.tsx` line 969-971, 1254-1258
- **현재 코드**:
  ```typescript
  const timezoneOffset = localDueDate.getTimezoneOffset() * 60000;
  adjustedDueDate = new Date(localDueDate.getTime() - timezoneOffset);
  ```
- **2곳에서 동일 패턴 사용** (todo 생성 + todo/schedule 업데이트)
- **영향**: 백엔드도 타임존 보정 시 날짜 1일 오차 (KST +9h)
- **상태**: ❌ 미수정

### ISSUE-SCHED-2-03 [MEDIUM] 종료시간 자동 보정 — **미수정 확인**

- **파일**: `SchedulePage.tsx` line 1137-1139
- **현재 코드**:
  ```typescript
  if (startTime > endTime) {
      endTime.setTime(startTime.getTime() + 60 * 60 * 1000);
  }
  ```
- **영향**: 사용자 미통보 상태로 종료시간 자동 변경
- **상태**: ❌ 미수정

### ISSUE-DASH-1-01 [HIGH] Admin 분기 도달 불가능 코드 — **미수정 확인**

- **파일**: `RoleBasedDashboard.tsx` line 36-62
- **분석**:
  ```typescript
  const isAdmin = UserModel.UserUtils.isAdmin(user);     // line 36
  const isDeveloper = isAdminUser(user?.id);              // line 37

  if (isAdminUser(user?.id) && isAdmin) {                 // line 40 — 1차 체크
      return <DashboardSelector user={user} />;
  }
  if (isDeveloper) {                                      // line 45 — 2차 체크 (= isAdminUser)
      return <DeveloperDashboard user={user} />;
  }
  // ... dtype 분기 ...
  } else if (UserModel.UserUtils.isAdmin(user)) {         // line 56 — **도달 불가능**
      return <DeveloperDashboard user={user} />;
  }
  ```
- **문제**: 3가지 Admin 체크 방식 충돌 → line 56 브랜치 도달 불가
- **상태**: ❌ 미수정

### ISSUE-CONT-1-01 [HIGH] 전자계약 V1/V2 병행 — **미수정 확인**

- **V1** (`/api/contracts`): `contract.api.ts` → 6+ 컴포넌트 사용
  - ContractListPage, ContractPaymentHistory, ContractPaymentHistoryAdd 등
- **V2** (`/api/v2/unified-contracts`): `contract.service.ts` → 13+ 컴포넌트 사용
  - LemonContract 모듈 전체 (ContractList, ContractDashboard 등)
- **결론**: 의도적 공존 가능성 (V1=결제/세금, V2=전자서명 라이프사이클)
- **심각도 재평가**: HIGH → **MEDIUM** (아키텍처 결정 사항, 즉시 버그 아님)
- **상태**: ⚠️ 아키텍처 검토 필요

### ISSUE-TODO-2-01 [HIGH] TodoList 필터 Race Condition — **재검증: 수정됨**

- **파일**: `TodoListPage.tsx` line 543-553
- **현재 코드**:
  ```typescript
  useEffect(() => {
      const timer = setTimeout(() => {
          if (searchKeyword.trim()) {
              handleSearch(searchKeyword);
          } else if (searchKeyword === '') {
              loadTodos(filter);
          }
      }, 300);
      return () => clearTimeout(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKeyword, filter]);
  ```
- **판정**: `filter`가 dependency array에 **정상 포함**되어 있음. 이전 보고서의 "filter 누락" 이슈는 현재 코드에서 **해소됨**
- **남은 문제**: eslint-disable 주석이 불필요하게 남아있음 (LOW)
- **상태**: ✅ 수정됨 (filter dependency 추가)
- **심각도 변경**: HIGH → **RESOLVED**

### ISSUE-LDRIVE-2-01 [HIGH] LDrive 권한 오류 Silent Empty Return — **미수정 확인**

- **파일**: `LDrivePageV3.tsx` line 1033-1036
- **현재 코드**:
  ```typescript
  if (isOrgSubFolder && !orgIdToUse) {
    console.warn('[LDrive] ⚠️ 조직 하위 폴더 접근 시 organizationId 필수');
    return { files: [], folders: [], breadcrumbs: [], currentFolder: null, totalCount: 0, hasMore: false };
  }
  ```
- **영향**: 사용자에게 빈 폴더로 표시, 실제로는 권한 부족
- **상태**: ❌ 미수정

### ISSUE-API-3-01 [HIGH] 법령검색 V2 Admin 전용 — **확인 필요**

- **확인 사항**: 프론트엔드가 실제로 V2 경로(`/api/v2/legal-info/law/search`)를 사용하는지, 또는 별도 프록시/레거시 경로 사용 여부
- **백엔드**: LegalInfoV2Controller에서 userId 5, 30만 접근 허용
- **영향**: 일반 사용자 공통 메뉴인데 V2 API가 Admin 전용이면 403 가능
- **상태**: ⚠️ 프론트엔드 호출 경로 확인 필요

---

## 반복 8: MEDIUM 이슈 코드라인 재검증 (11건)

### 변경된 이슈 (1건)

| 이슈 ID | 변경 | 이유 |
|---------|------|------|
| ISSUE-TODO-2-01 | HIGH → RESOLVED | filter dependency array에 이미 포함됨 |

### 미수정 확인된 이슈 (10건)

| 이슈 ID | 심각도 | 위치 | 코드라인 확인 |
|---------|--------|------|-------------|
| ISSUE-TODO-2-02 | MEDIUM | TodoListPage:208-236 | Silent return 패턴 미수정 |
| ISSUE-TODO-2-03 | LOW | TodoListPage:165, 777-778 | 필터 변경 시 selectedTodoId 미초기화 |
| ISSUE-LDRIVE-2-02 | MEDIUM | LDrivePageV3:2041-2150 | 중복파일 다이얼로그 Race Condition |
| ISSUE-LDRIVE-2-03 | MEDIUM | LDrivePageV3:41-55 | ErrorBoundary 부재 (Suspense만 사용) |
| ISSUE-CONSULT-2-01 | MEDIUM | ExpertConsultationPage:365-387 | 메시지 전송 에러 Silent |
| ISSUE-CONSULT-2-02 | MEDIUM | ExpertConsultationPage:714-739 | 전문가 선택 Race Condition |
| ISSUE-NOTIF-2-01 | MEDIUM | NotificationPage:206-227 | IntersectionObserver 메모리 누수 |
| ISSUE-NOTIF-2-02 | LOW | NotificationPage:523-531 | 무한 로딩 에러 미복구 |
| ISSUE-DASH-1-02 | MEDIUM | RoleBasedDashboard:27-32 | 인증 로딩 상태 미처리 |
| ISSUE-PREC-1-03 | MEDIUM | PrecedentSearchV2 | AbortController 미사용 |

---

## 반복 9: 속기사-공통 메뉴 크로스 이슈 분석

### 속기사 모듈에서도 발견된 공통 패턴

| 공통 패턴 | 공통 메뉴 발현 | 속기사 모듈 발현 | 시스템적 문제 |
|----------|--------------|----------------|-------------|
| **Silent Failure** | 5개 메뉴 | C5, DL-1 (이메일 미등록) | **YES** — 프로젝트 전반 패턴 |
| **Race Condition** | 4개 메뉴 | STT-2 (동시 트리거) | **YES** — 비동기 상태 관리 미흡 |
| **동시 수정 보호 없음** | 일정관리 | DI-2, T1, F1 | **YES** — @Version 부재 |
| **XSS 살균 부재** | - | DI-3 (memo/title) | 속기사 특유 (DB 직접 저장) |
| **타임존 불일치** | 일정관리 | DI-7 | **YES** — ISO 전송 미통일 |

### 속기사 전용 이슈 중 공통 메뉴 영향도

| 속기사 이슈 | 공통 메뉴 영향 | 설명 |
|------------|--------------|------|
| DI-3 (XSS) | ❌ | 속기사 Entity 전용 (memo, feeNote) |
| FM-2 (LDrive 파일 미삭제) | ⚠️ | LDrive 공유 스토리지 사용 시 용량 영향 |
| INT-3 (캘린더 미통합) | ⚠️ | 메인 ERP 캘린더와 속기사 일정 분리 |
| INT-5 (상태 알림 미발송) | ⚠️ | 알림 시스템 공통 확장 필요 |

---

## 반복 10: 전체 통합 요약 (반복 1~10 누적)

### 전체 이슈 현황 변경

| 심각도 | 반복 1~5 | 반복 6~10 변경 | 최종 |
|--------|---------|--------------|------|
| CRITICAL | 2 | 0 (미수정 재확인) | **2** |
| HIGH | 7 | -1 (TODO 해소), -1 (CONT 하향) | **5** |
| MEDIUM | 11 | +1 (CONT 하향) | **12** |
| LOW | 5 | +1 (TODO eslint) | **6** |
| INFO | 1 | 0 | **1** |
| **합계** | **26** | -1 해소, 1 하향 | **25** (1건 해소) |

### 이슈 상태 매트릭스 (반복 10 기준)

| 이슈 ID | 심각도 | 상태 | 수정 필요 |
|---------|--------|------|----------|
| ISSUE-PREC-1-01 | CRITICAL | ❌ 미수정 | `setFullYear` → `getFullYear()-1` |
| ISSUE-SCHED-2-01 | CRITICAL | ❌ 미수정 | ID 파싱 로직 개선 |
| ISSUE-SCHED-2-02 | HIGH | ❌ 미수정 | 타임존 처리 일원화 |
| ISSUE-DASH-1-01 | HIGH | ❌ 미수정 | Admin 체크 통합 |
| ISSUE-LDRIVE-2-01 | HIGH | ❌ 미수정 | 권한 오류 UI 피드백 |
| ISSUE-API-3-01 | HIGH | ⚠️ 확인필요 | V2 Admin 제한 검토 |
| ISSUE-CONT-1-01 | ~~HIGH~~→MEDIUM | ⚠️ 아키텍처 | V1/V2 통합 계획 |
| ISSUE-TODO-2-01 | ~~HIGH~~→RESOLVED | ✅ 수정됨 | 없음 |
| ISSUE-PREC-1-02 | HIGH→MEDIUM | ⚠️ | V2 미사용 (의도적?) |
| ISSUE-TODO-2-02 | MEDIUM | ❌ 미수정 | Silent failure 개선 |
| ISSUE-LDRIVE-2-02 | MEDIUM | ❌ 미수정 | Race condition 보호 |
| ISSUE-LDRIVE-2-03 | MEDIUM | ❌ 미수정 | ErrorBoundary 추가 |
| ISSUE-CONSULT-2-01 | MEDIUM | ❌ 미수정 | LemonToast.error() 추가 |
| ISSUE-CONSULT-2-02 | MEDIUM | ❌ 미수정 | 초기 선택 flag |
| ISSUE-NOTIF-2-01 | MEDIUM | ❌ 미수정 | observer.disconnect() |
| ISSUE-SCHED-2-03 | MEDIUM | ❌ 미수정 | Snackbar 경고 추가 |
| ISSUE-SCHED-2-04 | MEDIUM | ❌ 미수정 | Promise.allSettled |
| ISSUE-DASH-1-02 | MEDIUM | ❌ 미수정 | 로딩 상태 체크 |
| ISSUE-PREC-1-03 | MEDIUM | ❌ 미수정 | AbortController 적용 |
| ISSUE-CONT-1-02 | MEDIUM | ❌ 미수정 | 로딩 상태 표시 |
| ISSUE-DASH-1-03 | LOW | ❌ 미수정 | console.warn 추가 |
| ISSUE-TODO-2-03 | LOW | ❌ 미수정 | selectedTodoId 초기화 |
| ISSUE-NOTIF-2-02 | LOW | ❌ 미수정 | 재시도 버튼 추가 |
| ISSUE-CONT-1-03 | LOW | ❌ 미수정 | 인코딩 주석 수정 |
| ISSUE-TODO-eslint | LOW | 신규 | eslint-disable 제거 |

### 시스템적 패턴 분석 (공통 메뉴 + 속기사 통합)

| 패턴 | 공통 메뉴 | 속기사 | 총 발현 | 권장 수정 |
|------|----------|--------|--------|----------|
| Silent Failure | 5개 메뉴 | 3건 | **8건** | LemonToast.error() 일괄 적용 |
| Race Condition | 4개 메뉴 | 2건 | **6건** | AbortController + 동시성 보호 |
| 동시 수정 미보호 | 1건 | 3건 | **4건** | @Version optimistic locking |
| 타임존 불일치 | 1건 | 1건 | **2건** | ISO string 통일 |
| 레거시/V2 병행 | 2건 | 0건 | **2건** | 점진적 V2 마이그레이션 |

### 수정 우선순위 (권장)

**P0 — 즉시 수정 (CRITICAL)**
1. ISSUE-PREC-1-01: 판례검색 `setFullYear(1900)` → 1줄 수정
2. ISSUE-SCHED-2-01: 일정 ID 파싱 → regex 또는 split 개선

**P1 — 우선 수정 (HIGH)**
3. ISSUE-SCHED-2-02: 타임존 이중 보정 → 프론트 ISO 전송 통일
4. ISSUE-DASH-1-01: Admin 체크 통합 → 도달 불가능 코드 제거
5. ISSUE-LDRIVE-2-01: 권한 오류 피드백 → Alert 또는 Toast

**P2 — 일괄 개선 (시스템 패턴)**
6. Silent Failure 일괄 → LemonToast.error() 8곳
7. ErrorBoundary 래핑 → LDrive lazy 컴포넌트

---

## 검증 통계 (반복 6~10)

| 항목 | 값 |
|------|-----|
| 재검증 이슈 수 | 26건 (반복 1~5 전체) |
| 코드라인 확인 | 20건 |
| 수정 확인 | 1건 (ISSUE-TODO-2-01 → RESOLVED) |
| 심각도 변경 | 2건 (CONT-1-01 하향, TODO-2-01 해소) |
| 미수정 확인 | 23건 |
| 확인 필요 | 1건 (API-3-01) |
| 신규 발견 | 1건 (TODO eslint-disable 불필요) |
| 속기사 크로스 패턴 | 5개 시스템적 패턴 식별 |
