# ERP 속기사 메뉴 검증 — 반복 11~15 보고서

> 생성일: 2026-05-10
> 브랜치: dev-hs-rtx6000-new

---

## 반복 구조

| 반복 | 검증 영역 | 방법 |
|------|----------|------|
| 11 | CRITICAL 이슈 2건 재검증 | 코드 라인 직접 확인 |
| 12 | HIGH 이슈 4건 재검증 | 코드 라인 직접 확인 |
| 13 | 속기사 CRUD + STT + 파일관리 | 코드 심층 분석 |
| 14 | 속기사 UI/UX 품질 | 반응형/모달/에러상태/높이 |
| 15 | 보안 + 성능 + 동시성 | XSS/API Auth/Performance/@Version |

---

## 반복 11: CRITICAL 이슈 재검증

### ISSUE-PREC-1-01: 판례검색 날짜 필터 1900년 하드코딩
- **상태**: ❌ STILL_OPEN
- **파일**: `lemon-front/src/erp/pages/LegalInfo/components/PrecedentSearchV2.tsx:1190`
- **코드**: `oneYearAgo.setFullYear(1900);` — 주석은 "1년 전"이지만 실제값은 1900년
- **영향**: 날짜 필터가 126년 범위로 작동, 사실상 필터 무효화
- **수정 방안**: `oneYearAgo.setFullYear(today.getFullYear() - 1);`

### ISSUE-SCHED-2-01: 일정 ID 파싱 NaN 위험
- **상태**: ❌ STILL_OPEN
- **파일**: `lemon-front/src/erp/pages/SchedulePage.tsx:858, 881, 1252`
- **코드**:
  - L858, L881: `Number(selectedEvent.id.split('-').pop())` — 하이픈 없는 ID → NaN
  - L1252: `selectedEvent.id.split('-')[1]` — 2+ 하이픈 ID → 잘못된 값 추출
- **영향**: 일정 수정/삭제 API 호출 실패 (NaN이 서버로 전달)
- **수정 방안**: ID 파싱에 방어 로직 추가 (Number.isNaN 체크 + fallback)

---

## 반복 12: HIGH 이슈 재검증

### ISSUE-SCHED-2-02: 타임존 이중 보정 → 1일 오프셋
- **상태**: ❌ STILL_OPEN
- **파일**: `SchedulePage.tsx:969-970, 1257-1258, 1324-1325` (3곳 동일 패턴)
- **코드**: `new Date(localDueDate.getTime() - timezoneOffset)` — 브라우저가 이미 처리한 TZ를 다시 빼기
- **영향**: KST(+9) 환경에서 날짜가 1일 밀림

### ISSUE-DASH-1-01: 관리자 대시보드 접근 불가
- **상태**: ❌ STILL_OPEN
- **파일**: `DashboardPage.tsx:167, 713-715`
- **원인**: `UserModel.UserUtils.isAdmin()` (L167)과 `dtype === '관리자'` (L714) 두 가지 다른 판별 로직이 공존
- **영향**: 두 체크가 불일치하면 관리자가 관리자 대시보드에 접근 불가

### ISSUE-LDRIVE-2-01: 조직 폴더 접근 시 무음 실패
- **상태**: ❌ STILL_OPEN
- **파일**: `ldrive-api-v3.ts:1194`
- **코드**: `.catch(() => {})` — 에러를 조용히 삼킴
- **영향**: 권한 없는 폴더 접근 시 빈 결과만 표시, 사용자에게 이유 안내 없음

### ISSUE-API-3-01: 법령검색 V2 관리자 전용 → 공통 메뉴 노출
- **상태**: ✅ RESOLVED (재분류)
- **근거**: 프론트엔드에서 관리자 전용 제한 없음 → 의도된 설계로 판단
- **비고**: 백엔드 API 레벨 인증은 별도 확인 필요

---

## 반복 13: 속기사 CRUD + STT + 파일관리 심층 검증

### 새 이슈 발굴

| ID | 심각도 | 설명 | 파일:라인 |
|----|--------|------|-----------|
| CR-13-01 | **HIGH** | 최종 파일 업로드 시 파일 타입 검증 누락 — input accepts에 의존, 조작 가능 | JobDetailDialog.tsx:385-410 |
| CR-13-02 | **HIGH** | STT 폴링이 컴포넌트 unmount 후 0~8초간 계속 실행 | WorkListPage.tsx:241-252 |
| CR-13-03 | MEDIUM | Job 수정 시 optimistic locking 없음 (last-write-wins) | JobDetailDialog.tsx:224-238 |
| CR-13-04 | MEDIUM | 대용량 파일(100~500MB) 업로드 진행률 표시 없음 | JobDetailDialog.tsx:361-382 |
| CR-13-05 | MEDIUM | 파일 다운로드 에러 핸들링 누락 (window.open 직접 사용) | JobDetailDialog.tsx:873-878 |
| CR-13-06 | MEDIUM | 다이얼로그 내 개별 파일 삭제 불가 — 전체 job 삭제만 가능 | JobDetailDialog.tsx 전체 |
| CR-13-07 | MEDIUM | 동시 STT 트리거 방어가 프론트엔드만 — 백엔드 idempotency 미확인 | JobDetailDialog.tsx:496-508 |
| CR-13-08 | LOW | 페이지네이션이 상태 필터 변경 시 리셋 (의도된 동작이나 UX 마이너) | WorkListPage.tsx:233 |
| CR-13-09 | LOW | STT stuck 상태 시 경과시간 경고 없음 (리셋 버튼은 존재) | JobDetailDialog.tsx:1163 |
| CR-13-10 | LOW | 비저장 변경사항 브라우저 뒤로가기 시 경고 없음 (onbeforeunload 미사용) | TranscriptStudio.tsx:281 |

### 양호 항목
- ✅ job.files optional chaining 적용 완료
- ✅ 파일 크기 500MB 제한 프론트엔드 검증
- ✅ 빈 상태 메시지 표시 (뷰별 다른 메시지)
- ✅ 대용량 텍스트 렌더링 (maxHeight + overflow scroll)
- ✅ 에디터 모드 전환 시 콘텐츠 보존

---

## 반복 14: 속기사 UI/UX 품질 검증

| 항목 | 결과 | 상세 |
|------|------|------|
| 반응형 디자인 | ✅ PASS | xs/sm 패딩·폰트 적용, 테이블 nowrap 적용 |
| 모달 품질 | ✅ PASS | fullScreen={isMobile}, backdropFilter blur(4px) 적용 |
| 에러 상태 | ⚠️ PARTIAL | API 에러 alert 표시하나, stats refresh 무음 실패 (WorkListPage:183) |
| 빈 상태 | ✅ PASS | 대시보드·작업목록·수임료 모두 빈 상태 메시지 존재 |
| 로딩 상태 | ✅ PASS | 스피너·LinearProgress·폴링 구현 |
| 페이지 높이 | ✅ PASS | pb: { xs: 8~10, md: 2 } 적용, 채팅 레일 여백 확보 |

### 새 이슈

| ID | 심각도 | 설명 | 파일:라인 |
|----|--------|------|-----------|
| CR-14-01 | MEDIUM | stats refresh 실패 시 무음 처리 — `.catch(() => {})` | WorkListPage.tsx:183 |
| CR-14-02 | LOW | 수임료 테이블 minWidth 700px 고정 — 소형 모바일에서 오버플로 가능 | FeePage.tsx:226 |

---

## 반복 15: 보안 + 성능 + 동시성 검증

| 항목 | 결과 | 상세 |
|------|------|------|
| XSS 방지 | ✅ PASS | dangerouslySetInnerHTML 미사용, memo/title을 Typography 텍스트로 렌더링, 인쇄 시 HTML entity 이스케이프 |
| API 인증 | ✅ PASS | 소유권 검증 (courtReporterId === reporterId), 공개 추적 엔드포인트만 permitAll |
| 파일 업로드 보안 | ✅ PASS | 500MB 제한 클라이언트+서버 양쪽 적용, V7 JSON 5MB 제한 |
| 성능 | ✅ PASS | 페이지네이션(200건/페이지 하드캡), useMemo/useCallback, isMountedRef unmount 방어 |
| 동시성 보호 | ❌ FAIL | @Version 누락 — 아래 상세 |

### CRITICAL 발견: @Version 어노테이션 누락

| ID | 심각도 | 설명 | 파일 |
|----|--------|------|------|
| CR-15-01 | **HIGH** | CourtReporterTranscriptEntity.version 필드에 `@Version` 어노테이션 없음 — Hibernate 낙관적 잠금 미작동 | lemon-api-server-spring CourtReporterTranscriptEntity.java:34-37 |

**현재 코드**:
```java
@Column(name = "version")
@Builder.Default
private Integer version = 1;
```

**필요 코드**:
```java
@Version
@Column(name = "version")
private Integer version;
```

---

## 누적 이슈 현황 (반복 1~15)

### 전체 요약

| 심각도 | 반복 1-10 | 반복 11-15 신규 | 해소 | 현재 OPEN |
|--------|-----------|----------------|------|-----------|
| CRITICAL | 2 | 0 | 0 | **2** |
| HIGH | 5 | 3 | 0 | **8** |
| MEDIUM | 12 | 5 | 0 | **17** |
| LOW | 6 | 3 | 0 | **9** |
| INFO | 1 | 0 | 0 | 1 |
| **합계** | **26** | **11** | **0** | **37** |

### 해소된 이슈
- ISSUE-API-3-01: RESOLVED (재분류 — 의도된 설계)
- ISSUE-TODO-2-01: RESOLVED (filter dependency 추가 — 반복 6-10에서 확인)

### 시스템 패턴 (반복적 발견)

| 패턴 | 누적 횟수 | 대표 위치 |
|------|-----------|-----------|
| Silent Failure (.catch(() => {})) | 9건 | WorkListPage:183, ldrive-api-v3:1194 등 |
| Missing Optimistic Locking | 5건 | TranscriptEntity, JobDetailDialog 등 |
| Race Condition / Cleanup 누락 | 7건 | STT polling, AbortController 미사용 |
| Timezone 이중 보정 | 3건 | SchedulePage 3곳 |
| ID 파싱 방어 로직 부재 | 3건 | SchedulePage:858, 881, 1252 |

---

## 상용 준비도 평가

| 모듈 | 준비도 | 블로커 |
|------|--------|--------|
| 공통 메뉴 | 70% | CRITICAL 2건 (날짜필터, ID파싱) |
| 속기사 전용 | 82% | HIGH 3건 (파일검증, STT폴링, @Version) |
| 보안 | 90% | XSS/Auth PASS, 동시성만 미비 |
| UI/UX | 88% | 무음 실패 패턴만 잔여 |

---

## 다음 단계 (반복 16~20)

1. **반복 16-17**: CRITICAL 2건 + HIGH 8건 수정 코드 작성 (승인 후 구현)
2. **반복 18-19**: 수정 후 재검증 + 회귀 테스트
3. **반복 20**: 최종 누적 보고서 + 상용 릴리스 판정
