# 속기사(Court Reporter) ERP 핵심 기능 검증

> 최종 업데이트: 2026-05-08
> 검증 방법: 코드 레벨 분석 (Spring API 502로 라이브 테스트 불가)

---

## 검증 범위

| 기능 | 프론트엔드 | 백엔드 | 상태 |
|------|-----------|--------|------|
| 작업 생성 (CREATE) | CourtReporterJobCreateDialog.tsx | CourtReporterJobService:174-200 | 동작 확인 (이슈 6건) |
| 작업 조회 (LIST) | CourtReporterWorkListPage.tsx | CourtReporterJobController:44-60 | 동작 확인 (이슈 1건) |
| 필터링 (FILTER) | WorkListPage 탭/검색 | Repository nativeQuery | 동작 확인 (이슈 1건) |
| 상태 변경 (UPDATE/status) | JobDetailDialog:230 | Service:224 | 동작 확인 |
| 정보 수정 (UPDATE/info) | JobDetailDialog:310-315 | Service:153-155 | 동작 확인 (이슈 1건) |
| 메모 수정 (UPDATE/memo) | JobDetailDialog:684 | Service:250 | 동작 확인 |
| 수수료 수정 (UPDATE/fee) | JobDetailDialog:287-294 | Service:260-276 | 동작 확인 (이슈 1건) |
| 속기록 수정 (UPDATE/transcript) | JobDetailDialog:241,262 | Service:373-386 | 동작 확인 (이슈 1건) |
| 작업 삭제 (DELETE) | WorkListPage:279 | Service:527 | 동작 확인 (이슈 1건) |

---

## 1. 작업 생성 (CREATE)

### 프론트엔드: CourtReporterJobCreateDialog.tsx

**수집 필드:**
- title (필수), eventType (선택: 법정속기/회의속기/영상속기/인터뷰속기/기타)
- priority (NORMAL/HIGH/URGENT, 기본 NORMAL)
- eventDate (선택, datetime-local), durationMinutes (선택, 정수)
- location (선택), clientName/clientPhone/clientEmail (선택)
- memo (선택, 멀티라인)

**프론트엔드 검증 (handleSubmit:64-90):**
- title: 비어있으면 거부 (trim 후 검사)
- eventDate: 입력 시 Date 파싱 유효성 확인
- durationMinutes: 입력 시 정수 > 0, <= 1440 (24시간)
- 이메일/전화번호 형식 검증 없음

**성공 동작:** 폼 초기화 + onCreated() 콜백 호출 (부모 컴포넌트가 목록 갱신)
**에러 처리:** axios 에러 메시지 추출, 실패 시 "생성 실패" Alert 표시

### 백엔드: CourtReporterJobService:174-200

**검증:**
- title: blank 불가 (IllegalArgumentException)
- durationMinutes: 입력 시 1-1440 범위

**처리:**
- priority null이면 "NORMAL" 기본값 설정
- 12자 영숫자 trackingCode 자동 생성
- 상태 PENDING으로 초기화

### 발견된 이슈

| # | 이슈 | 심각도 | 위치 |
|---|------|--------|------|
| C1 | priority 백엔드 enum 검증 없음 (프론트만 제한) | 중 | Service:195 |
| C2 | clientEmail/clientPhone 형식 검증 없음 (양쪽 모두) | 중 | Dialog:64-90, Service:174-200 |
| C3 | eventType 백엔드 화이트리스트 없음 (임의 문자열 저장 가능) | 낮 | Service:190 |
| C4 | clientName/Phone/Email 백엔드 trim 누락 (PATCH에서는 trim 있음) | 낮 | Service:174-200 vs 161-163 |
| C5 | clientEmail null 허용 → 나중에 최종파일 발송 시 에러 발생 지연 | 중 | Service:441-444 |
| C6 | durationMinutes 프론트에서 string→number 변환 시 fragile | 낮 | Dialog:79 |

---

## 2. 작업 조회 및 필터링 (LIST/FILTER)

### 프론트엔드: CourtReporterWorkListPage.tsx

**필터 파라미터:**
- status: 6개 탭 (PENDING, IN_PROGRESS, COMPLETED, DELIVERED, CANCELLED, 전체)
- search: 300ms 디바운스 적용
- 뷰 모드: list, stt (STT 처리), edit (편집 대기)
- 페이지 크기: 30 (CR_CONFIG.PAGE_SIZE)

**페이지네이션:**
- MUI Pagination: 1-based 표시 / 0-based 내부 저장 (정확)
- totalPages > 1일 때만 표시
- 필터 변경 시 pageNum 0으로 리셋 (useEffect:233)

### 백엔드: CourtReporterJobController:44-60, Repository:20-62

**쿼리 파라미터:** status, search, page, size, startDate, endDate
**검색 대상:** title, client_name, client_phone, tracking_code (대소문자 무관)
**정렬:** created_at DESC (고정)
**페이지네이션 안전장치:** page >= 0, size 1-200 범위 클램핑

### 발견된 이슈

| # | 이슈 | 심각도 | 위치 |
|---|------|--------|------|
| L1 | 날짜 범위 필터: 백엔드 구현됨, 프론트엔드에서 미전송 | 중 | WorkListPage:211-213 |

---

## 3. 상태 변경 (UPDATE/status)

### 동작 흐름
- UI: "상태 변경" 섹션의 Chip 버튼 클릭 (JobDetailDialog:587)
- Payload: `{ status: string }`
- 백엔드: VALID_STATUSES 배열로 검증 (Service:224)
- 성공: Toast 표시, 목록 갱신

### 상태값
PENDING → IN_PROGRESS → COMPLETED → DELIVERED / CANCELLED

**이슈 없음.** 정상 구현.

---

## 4. 정보 수정 (UPDATE/info)

### 동작 흐름
- UI: "기본 정보" 섹션의 편집 아이콘 클릭 → 인라인 폼 표시 (JobDetailDialog:601)
- Payload: title, priority, clientName/Phone/Email, eventType, eventDate, durationMinutes, location
- 프론트엔드 검증: title 필수, durationMinutes 1-1440
- 백엔드 검증: 동일 + priority enum 체크 (Service:153-155)

### 발견된 이슈

| # | 이슈 | 심각도 | 위치 |
|---|------|--------|------|
| U1 | 취소 시 폼 상태 미초기화 (stale values) | 낮 | JobDetailDialog:610 |

---

## 5. 메모 수정 (UPDATE/memo)

### 동작 흐름
- UI: 메모 섹션 인라인 편집 (JobDetailDialog:684)
- Payload: `{ memo: string }`
- 백엔드: trim 처리 (Service:250)
- 길이 제한 없음 (의도적으로 보임)

**이슈 없음.** 정상 구현.

---

## 6. 수수료 수정 (UPDATE/fee)

### 동작 흐름
- UI: "수수료 현황" 편집 버튼 (JobDetailDialog:943)
- Payload: `{ feeAmount: number|null, feeStatus, feeNote }`
- 프론트엔드: feeAmount >= 0, <= 999,999,999 (lines 287-294)
- 백엔드: BigDecimal 검증 + VALID_FEE_STATUSES 체크 (Service:260-265)
- 상태 전이 시 feeBilledAt/feePaidAt 자동 타임스탬프 (Service:273-276)

### 발견된 이슈

| # | 이슈 | 심각도 | 위치 |
|---|------|--------|------|
| F1 | 동시 수정 보호 없음 (optimistic locking 부재) | 중 | Service:260-276 |

---

## 7. 속기록 수정 (UPDATE/transcript)

### 동작 흐름
- UI: 속기록 행의 편집 버튼 (JobDetailDialog:797) 또는 "최종 확정" 버튼 (line 786)
- Payload: `{ transcriptionEdited: string }` 또는 `{ isFinal: true }`
- 백엔드: isFinal=true인 속기록은 수정 거부 (Service:373-379)
- V7Json 처리: 평문 수정 시 V7Json 리셋 (Service:384-386)
- 최종 확정 시 confirmation 다이얼로그 표시

### 발견된 이슈

| # | 이슈 | 심각도 | 위치 |
|---|------|--------|------|
| T1 | 버전 잠금 없음 — 동시 편집 시 last-write-wins | 높 | TranscriptRepository (optimistic locking 부재) |

---

## 8. 작업 삭제 (DELETE)

### 동작 흐름
- UI: "작업 삭제" 버튼 (JobDetailDialog:1035)
- 확인: confirmDialog danger=true — "관련 파일과 속기록도 모두 삭제됩니다" (WorkListPage:280)
- 백엔드 처리 순서 (Service:527):
  1. job 조회 (reporterId 소유권 확인)
  2. transcripts 삭제
  3. files 삭제
  4. finalFiles 삭제
  5. job 삭제

### 발견된 이슈

| # | 이슈 | 심각도 | 위치 |
|---|------|--------|------|
| D1 | 감사 로그/소프트 삭제 없음 — 완전 삭제만 가능 | 중 | Service:527 |

---

## 전체 이슈 요약

| 심각도 | 건수 | 상세 |
|--------|------|------|
| 높 (High) | 1 | T1: 속기록 동시 편집 race condition |
| 중 (Medium) | 6 | C1(priority), C2(이메일형식), C5(이메일null), L1(날짜필터), F1(수수료동시수정), D1(감사로그) |
| 낮 (Low) | 4 | C3(eventType), C4(trim), C6(타입변환), U1(폼초기화) |

### 권장 개선 사항 (우선순위순)

1. **T1 (높)**: 속기록에 `@Version` 필드 추가하여 optimistic locking 적용
2. **C2 (중)**: clientEmail에 최소한의 형식 검증 추가 (@ 포함 여부)
3. **L1 (중)**: 프론트엔드에 날짜 범위 필터 UI 추가 (백엔드 이미 구현됨)
4. **C5 (중)**: 최종파일 발송 시 clientEmail 없으면 사전 경고 표시
5. **D1 (중)**: soft delete (deletedAt 컬럼) 도입 검토

---

## 검증 환경

- **프론트엔드 서버**: https://100.108.86.92:3011 (200 OK)
- **Spring API**: 502 Bad Gateway (서비스 다운 상태)
- **검증 방법**: 프론트엔드/백엔드 소스코드 정적 분석
- **검증 대상 파일**:
  - FE: `lemon-front/src/erp/pages/CourtReporter/` (페이지 5개 + 컴포넌트 8개)
  - BE: `lemon-api-server-spring/.../courtreporter/` (Controller 1개 + Service 1개 + Entity 4개)
