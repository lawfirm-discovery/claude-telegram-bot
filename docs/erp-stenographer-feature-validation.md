# 속기사(Court Reporter) ERP 핵심 기능 검증

> 최종 업데이트: 2026-05-08 (Iteration 4 — 전체 17개 엔드포인트 라이브 테스트 + 응답 본문 수집 완료)
> 검증 방법: 코드 레벨 정적분석 + Spring API 라이브 테스트 (17개 엔드포인트 전수 검증)

---

## 검증 환경

| 항목 | 상태 |
|------|------|
| 프론트엔드 서버 | https://100.108.86.92:3011 — **200 OK** |
| Spring API | https://100.108.86.92:3011/api — **200 OK** |
| 인증 보호 | 16개 엔드포인트 401 반환 확인 (응답: `{"error":true,"message":"인증이 필요합니다"}`) |
| 공개 추적 API | 인증 없이 접근 가능, 404 + 정확한 에러 메시지 |
| 프론트엔드 라우트 | 5개 모두 200 OK (dashboard/work/schedule/fee/tracking) |
| 테스트 일시 | 2026-05-08T11:10 KST (Iteration 4) |

### 라이브 테스트 결과 (전체 17개 엔드포인트)

| # | 엔드포인트 | 메서드 | 인증없이 | 예상 | 실제 | 비고 |
|---|-----------|--------|---------|------|------|------|
| 1 | `/api/court-reporter/jobs` | GET | 401 | 401 | **PASS** | 목록 조회 |
| 2 | `/api/court-reporter/jobs` | POST | 401 | 401 | **PASS** | 작업 생성 |
| 3 | `/api/court-reporter/jobs/stats` | GET | 401 | 401 | **PASS** | 통계 |
| 4 | `/api/court-reporter/jobs/1` | GET | 401 | 401 | **PASS** | 상세 조회 |
| 5 | `/api/court-reporter/jobs/1` | DELETE | 401 | 401 | **PASS** | 삭제 |
| 6 | `/api/court-reporter/jobs/1/info` | PATCH | 401 | 401 | **PASS** | 정보 수정 |
| 7 | `/api/court-reporter/jobs/1/status` | PATCH | 401 | 401 | **PASS** | 상태 변경 |
| 8 | `/api/court-reporter/jobs/1/memo` | PATCH | 401 | 401 | **PASS** | 메모 수정 |
| 9 | `/api/court-reporter/jobs/1/fee` | PATCH | 401 | 401 | **PASS** | 수수료 수정 |
| 10 | `/api/court-reporter/jobs/1/files` | POST | 401 | 401 | **PASS** | 파일 등록 |
| 11 | `/api/court-reporter/files/1/stt/trigger` | POST | 401 | 401 | **PASS** | STT 트리거 |
| 12 | `/api/court-reporter/files/1/stt` | PATCH | 401 | 401 | **PASS** | STT 상태 갱신 |
| 13 | `/api/court-reporter/transcripts/1` | PATCH | 401 | 401 | **PASS** | 속기록 수정 |
| 14 | `/api/court-reporter/jobs/1/final-files` | POST | 401 | 401 | **PASS** | 최종파일 등록 |
| 15 | `/api/court-reporter/jobs/1/final-files/1/send` | POST | 401 | 401 | **PASS** | 최종파일 발송 |
| 16 | `/api/court-reporter/jobs/1/contract` | GET | 401 | 401 | **PASS** | 계약 연결 |
| 17 | `/api/court-reporter/jobs/public/tracking/NONEXISTENT` | GET | 404 | 404 | **PASS** | 공개 추적 |

### 응답 본문 샘플

**인증 보호 엔드포인트 (16개 공통):**
```json
{"error":true,"message":"인증이 필요합니다"}
```

**공개 추적 API (존재하지 않는 코드):**
```json
{"path":"/api/court-reporter/jobs/public/tracking/NONEXISTENT","error":"Not Found","message":"존재하지 않는 추적코드입니다.","timestamp":"2026-05-08T11:10:31.677222538","status":404}
```

**공개 추적 API (빈 코드):** HTTP 404 (라우트 미매칭, 빈 본문)

---

## 검증 범위 총괄

| 기능 | 프론트엔드 | 백엔드 | API 라이브 | 판정 |
|------|-----------|--------|-----------|------|
| 작업 생성 (CREATE) | CourtReporterJobCreateDialog.tsx | Service:174-200 | 401 확인 | **PASS** (이슈 6건) |
| 작업 조회 (LIST) | CourtReporterWorkListPage.tsx | Controller:44-60 | 401 확인 | **PASS** (이슈 1건) |
| 필터링 (FILTER) | WorkListPage 탭/검색 | Repository nativeQuery | 코드검증 | **PASS** (이슈 1건) |
| 상태 변경 (UPDATE/status) | JobDetailDialog | Service:213-240 | 401 확인 | **PASS** |
| 정보 수정 (UPDATE/info) | JobDetailDialog | Service:143-170 | 401 확인 | **PASS** (이슈 1건) |
| 메모 수정 (UPDATE/memo) | JobDetailDialog | Service:244-252 | 401 확인 | **PASS** |
| 수수료 수정 (UPDATE/fee) | JobDetailDialog + FeePage | Service:256-280 | 401 확인 | **PASS** (이슈 1건) |
| 속기록 수정 (UPDATE/transcript) | TranscriptStudio | Service:361-405 | 401 확인 | **PASS** (이슈 1건) |
| 파일 업로드 | JobDetailDialog | Service:284-309 | 401 확인 | **PASS** |
| STT 트리거 | JobDetailDialog | Service:541-565 | 401 확인 | **PASS** |
| STT 상태 갱신 | (내부 콜백) | Service:313-357 | 401 확인 | **PASS** |
| 최종파일 등록 | JobDetailDialog | Service:409-426 | 401 확인 | **PASS** |
| 최종파일 발송 | JobDetailDialog | Service:430-480 | 401 확인 | **PASS** |
| 공개 추적 | TrackingPage | Service:484-500 | **404 라이브 확인** | **PASS** |
| 작업 삭제 (DELETE) | WorkListPage | Service:526-537 | 401 확인 | **PASS** (이슈 1건) |
| 통계 조회 | DashboardPage | Service:504-522 | 401 확인 | **PASS** |
| 계약 연결 | JobDetailDialog | Controller:272-282 | 401 확인 | **PASS** |

---

## 1. 작업 생성 (CREATE)

### API: `POST /api/court-reporter/jobs`

**프론트엔드 (CourtReporterJobCreateDialog.tsx)**
- 필수: title (trim 후 blank 검사)
- 선택: eventType (5종 드롭다운), priority (3종), eventDate, durationMinutes (1-1440), location, client 정보, memo
- 검증: title 필수, durationMinutes 범위, eventDate 파싱

**백엔드 (Service:174-200)**
- title blank 불가, durationMinutes 1-1440
- priority null → "NORMAL" 기본값
- trackingCode 12자 SecureRandom 자동생성 (유니크 보장, 최대 20회 재시도)
- status="PENDING", feeStatus 미설정(null)

### 이슈

| # | 이슈 | 심각도 |
|---|------|--------|
| C1 | priority 백엔드 enum 검증 없음 (프론트만 제한) | 중 |
| C2 | clientEmail/clientPhone 형식 검증 없음 | 중 |
| C3 | eventType 백엔드 화이트리스트 없음 | 낮 |
| C4 | clientName/Phone/Email 백엔드 trim 누락 (PATCH에서는 있음) | 낮 |
| C5 | clientEmail null → 최종파일 발송 시 에러 지연 발생 | 중 |
| C6 | durationMinutes string→number 변환 fragile | 낮 |

---

## 2. 작업 조회 및 필터링 (LIST/FILTER)

### API: `GET /api/court-reporter/jobs[?status=&search=&page=&size=&startDate=&endDate=]`

**프론트엔드 (WorkListPage.tsx)**
- 6개 상태 탭 + 3개 뷰 모드(list/stt/edit)
- search: 300ms 디바운스, 필터 변경 시 page 0 리셋
- 페이지네이션: CR_CONFIG.PAGE_SIZE=30, MUI Pagination

**백엔드 (Repository nativeQuery)**
- 검색: title, client_name, client_phone, tracking_code (LIKE, 대소문자 무관)
- 날짜: event_date 범위 (startDate/endDate)
- 정렬: created_at DESC (고정)
- 페이지: page >= 0, size 1-200 클램핑

### 이슈

| # | 이슈 | 심각도 |
|---|------|--------|
| L1 | 날짜 범위 필터: 백엔드 구현됨, WorkListPage에서 미전송 (SchedulePage/FeePage에서는 사용) | 중 |

---

## 3. 상태 변경 (UPDATE/status)

### API: `PATCH /api/court-reporter/jobs/{jobId}/status`

**상태 전이 규칙 (Service:213-220)**
```
PENDING     → {IN_PROGRESS, CANCELLED}
IN_PROGRESS → {COMPLETED, CANCELLED}
COMPLETED   → {DELIVERED, IN_PROGRESS, CANCELLED}
DELIVERED   → {COMPLETED}
CANCELLED   → {PENDING}
```

- 무효 전이 시 409 CONFLICT 반환
- 소유권(courtReporterId) 검증 → 404 NOT_FOUND

**이슈 없음.** 정상 구현.

---

## 4. 정보 수정 (UPDATE/info)

### API: `PATCH /api/court-reporter/jobs/{jobId}/info`

**백엔드 (Service:143-170)**
- title: trim 후 blank 불가
- durationMinutes: 1-1440 범위
- priority: VALID_PRIORITIES {NORMAL, HIGH, URGENT} 검증
- 나머지: null이 아닌 필드만 업데이트 (partial update)
- clientName/Phone/Email/location: trim 처리 + blank → null 변환

### 이슈

| # | 이슈 | 심각도 |
|---|------|--------|
| U1 | 취소 시 폼 상태 미초기화 (stale values) | 낮 |

---

## 5. 메모 수정 (UPDATE/memo)

### API: `PATCH /api/court-reporter/jobs/{jobId}/memo`

- 백엔드: trim 처리, blank → null 변환
- 길이 제한 없음 (의도적)

**이슈 없음.** 정상 구현.

---

## 6. 수수료 수정 (UPDATE/fee)

### API: `PATCH /api/court-reporter/jobs/{jobId}/fee`

**백엔드 (Service:256-280)**
- feeAmount: BigDecimal >= 0 (음수 불가)
- feeStatus: {PENDING, BILLED, PAID, CANCELLED} enum 검증
- 자동 타임스탬프: BILLED 최초 전환 → feeBilledAt, PAID 최초 전환 → feePaidAt (Asia/Seoul)

**프론트엔드 (FeePage.tsx)**
- FEE_VALID_TRANSITIONS: PENDING→{BILLED,CANCELLED}, BILLED→{PAID,PENDING,CANCELLED}, PAID→{} (terminal), CANCELLED→{PENDING}
- Optimistic UI update with rollback

### 이슈

| # | 이슈 | 심각도 |
|---|------|--------|
| F1 | 동시 수정 보호 없음 (optimistic locking 부재) | 중 |

---

## 7. 속기록 수정 (UPDATE/transcript)

### API: `PATCH /api/court-reporter/transcripts/{transcriptId}`

**백엔드 (Service:361-405)**
- isFinal=true인 속기록은 내용 수정 거부 (409 CONFLICT)
- isFinal=true인 속기록의 isFinal 해제도 거부
- 평문 수정 시 V7Json null로 리셋 (재생성 유도)
- V7Json 최대 5MB (Controller:214-215)
- 최종 확정 시 모든 파일 STT COMPLETED이면 job 자동 COMPLETED 전환

### 이슈

| # | 이슈 | 심각도 |
|---|------|--------|
| T1 | 버전 잠금 없음 — 동시 편집 시 last-write-wins | 높 |

---

## 8. 파일 업로드 및 STT

### API: `POST /api/court-reporter/jobs/{jobId}/files` + `POST /files/{fileId}/stt/trigger`

**파일 등록 (Service:284-309)**
- ldriveFileId 필수 (LDrive 업로드 후 UUID 전달)
- fileType: {AUDIO, VIDEO, DOCUMENT} (기본 AUDIO)
- sttStatus: PENDING으로 초기화

**STT 트리거 (Service:541-565)**
- PROCESSING 중이면 409 CONFLICT
- 최대 3회 시도 (초과 시 429 TOO_MANY_REQUESTS)
- 비동기 처리: FastAPI `/transcription/transcribe-audio` 호출, 10분 타임아웃
- 완료 시 자동으로 transcript 엔티티 생성 (버전 자동 증분)
- 실패 시 sttStatus → FAILED

**이슈 없음.** 정상 구현.

---

## 9. 최종파일 등록/발송

### API: `POST /jobs/{jobId}/final-files` + `POST /jobs/{jobId}/final-files/{fileId}/send`

**등록 (Service:409-426)**
- originalName 필수 (Controller:239-240)
- ldriveFileId로 LDrive 파일 참조

**발송 (Service:430-480)**
- clientEmail 없으면 400 BAD_REQUEST
- 이메일: "[리걸몬스터] 속기록 납품 안내 - {title}" + 추적 링크
- sentAt 타임스탬프 설정 (파일 + job 양쪽)
- 이메일 실패 시 500 + 로그

**이슈 없음.** 정상 구현.

---

## 10. 공개 추적 (라이브 테스트 완료)

### API: `GET /api/court-reporter/jobs/public/tracking/{trackingCode}`

**라이브 테스트 결과:**
- 존재하지 않는 코드 → 404 + `{"error":"Not Found","message":"존재하지 않는 추적코드입니다."}`
- 빈 코드 → 404 (라우트 매칭 실패)
- 인증 불필요 (확인됨)

**응답 구조 (코드분석):**
trackingCode, title, eventType, eventDate, location, status, hasFinalFile, updatedAt

**이슈 없음.** 정상 구현.

---

## 11. 작업 삭제 (DELETE)

### API: `DELETE /api/court-reporter/jobs/{jobId}`

**백엔드 (Service:526-537)**
- 소유권 확인 (courtReporterId)
- 캐스케이드 삭제 순서: transcripts → files → finalFiles → job

### 이슈

| # | 이슈 | 심각도 |
|---|------|--------|
| D1 | 감사 로그/소프트 삭제 없음 — 완전 삭제만 가능 | 중 |

---

## 12. 계약 연결 조회

### API: `GET /api/court-reporter/jobs/{jobId}/contract`

**백엔드 (Controller:272-282)**
- 작업에 연결된 수임계약 ID 조회
- 응답: `{"contractId": number|null, "hasContract": boolean}`

**이슈 없음.** 정상 구현.

---

## 전체 이슈 요약

| 심각도 | 건수 | 이슈 ID |
|--------|------|---------|
| 높 (High) | 1 | T1: 속기록 동시 편집 race condition |
| 중 (Medium) | 6 | C1(priority), C2(이메일형식), C5(이메일null지연), L1(날짜필터), F1(수수료동시수정), D1(감사로그) |
| 낮 (Low) | 4 | C3(eventType), C4(trim), C6(타입변환), U1(폼초기화) |

### 권장 개선 (우선순위)

1. **T1**: `@Version` 필드로 optimistic locking 적용
2. **C2/C5**: clientEmail 형식 검증 + 최종파일 UI에서 이메일 미등록 경고
3. **L1**: WorkListPage에 날짜 범위 필터 UI 추가 (백엔드 이미 구현됨)
4. **D1**: soft delete (deletedAt) 도입 검토

---

## 검증 대상 파일

**프론트엔드 (`lemon-front/src/erp/pages/CourtReporter/`)**
| 파일 | 용도 |
|------|------|
| CourtReporterDashboardPage.tsx | 대시보드 (통계+최근작업+오늘일정) |
| CourtReporterWorkListPage.tsx | 작업 목록 (list/stt/edit 3뷰) |
| CourtReporterSchedulePage.tsx | 캘린더 일정 관리 |
| CourtReporterFeePage.tsx | 수수료 관리 (필터+CSV) |
| CourtReporterTrackingPage.tsx | 공개 추적 페이지 |
| components/CourtReporterJobCreateDialog.tsx | 작업 생성 다이얼로그 |
| components/CourtReporterJobDetailDialog.tsx | 작업 상세 (4탭: 파일/속기록/최종본/수수료) |
| components/CourtReporterTranscriptStudio.tsx | 속기록 편집 스튜디오 (block/canvas/sebulsik) |
| courtReporterConstants.ts | API 엔드포인트/설정 상수 |

**백엔드 (`lemon-api-server-spring/.../courtreporter/`)**
| 파일 | 용도 |
|------|------|
| CourtReporterJobController.java (291줄) | REST 컨트롤러 (17 엔드포인트) |
| CourtReporterJobService.java (641줄) | 비즈니스 로직 + STT 비동기 |
| CourtReporterJobEntity.java | 작업 엔티티 (erp_court_reporter_jobs) |
| CourtReporterTranscriptEntity.java | 속기록 엔티티 |
| CourtReporterJobFileEntity.java | 작업 파일 엔티티 |
| CourtReporterFinalFileEntity.java | 최종 납품 파일 엔티티 |
| CourtReporterJobRepository.java (73줄) | 네이티브 SQL 필터 쿼리 |
| CourtReporterJobDto.java | DTO (Create/Update/Response 전체) |
