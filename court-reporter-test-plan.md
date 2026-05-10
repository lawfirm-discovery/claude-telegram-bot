# 속기사(Court Reporter) ERP — 메뉴별 테스트 항목 정의

## 테스트 환경
- 테스트 서버: http://100.108.86.92:3011
- 브랜치: `dev-hs-rtx6000-new`
- 사용자 타입: COURT_REPORTER (속기사 전문가)

---

## 1. 대시보드 (/pro/court-reporter/dashboard)

### 기능 설명
상태별 건수 통계, 최근 의뢰 5건, 오늘 일정, 빠른 작업 버튼

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| D-1 | 페이지 로드 시 통계 카드 표시 | PENDING/IN_PROGRESS/COMPLETED/DELIVERED 각 건수 정상 표시 | P0 |
| D-2 | 최근 의뢰 5건 표시 | createdAt 역순으로 최대 5건, 제목/상태/날짜 표시 | P0 |
| D-3 | 오늘 일정 목록 | eventDate가 오늘인 작업만 필터링 | P1 |
| D-4 | "새 의뢰" 버튼 → 생성 다이얼로그 | CourtReporterJobCreateDialog 정상 오픈 | P0 |
| D-5 | 의뢰 클릭 → 상세 다이얼로그 | CourtReporterJobDetailDialog에 선택 job 데이터 전달 | P0 |
| D-6 | 로딩 상태 표시 | API 호출 중 CircularProgress 노출 | P2 |
| D-7 | 에러 상태 표시 | API 실패 시 Alert 컴포넌트로 에러 메시지 표시 | P1 |
| D-8 | 다크모드 대응 | theme.palette 기반 색상, 하드코딩 색상 없음 | P2 |
| D-9 | 모바일 반응형 | isMobile 분기로 레이아웃 적응 | P1 |

---

## 2. 의뢰 관리 — 작업 목록 (/pro/court-reporter/work)

### 기능 설명
속기 의뢰 CRUD, 상태별 탭 필터, 검색, 페이지네이션, 파일 업로드, STT 변환

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| W-1 | 전체 목록 로드 | GET /api/court-reporter/jobs 호출, jobs 배열 렌더링 | P0 |
| W-2 | 상태 탭 필터 | "전체/대기/진행중/완료/납품완료" 탭 클릭 시 해당 상태만 표시 | P0 |
| W-3 | 검색 (제목/의뢰인) | TextField 입력 → 필터링 적용 | P1 |
| W-4 | 페이지네이션 | PAGE_SIZE=30 초과 시 Pagination 컴포넌트 동작 | P1 |
| W-5 | 새 의뢰 생성 | "새 의뢰" 버튼 → CreateDialog → 입력 → POST → 목록 갱신 | P0 |
| W-6 | 의뢰 상세 조회 | 카드 클릭 → DetailDialog 오픈 → 모든 필드 표시 | P0 |
| W-7 | 상태 변경 | PENDING→IN_PROGRESS→COMPLETED→DELIVERED 순서 전이 | P0 |
| W-8 | 파일 업로드 | AUDIO/VIDEO/DOCUMENT 타입 파일 업로드 성공 | P0 |
| W-9 | STT 변환 트리거 | 오디오 파일 → STT 시작 → 폴링(8초) → 결과 수신 | P0 |
| W-10 | 의뢰 삭제 | confirmDialog 확인 후 DELETE → 목록에서 제거 | P1 |
| W-11 | 우선순위 표시/변경 | NORMAL/HIGH/URGENT 칩 색상 구분 및 변경 | P1 |
| W-12 | 메모 저장 | 메모 텍스트 입력 → PATCH → 저장 확인 | P2 |
| W-13 | 통계 패널 | CourtReporterStatsPanel 상단 통계 정상 표시 | P1 |

---

## 3. 의뢰 링크 생성 (/pro/court-reporter/request-link)

### 기능 설명
의뢰에 대한 공개 트래킹 코드 생성 및 URL 공유

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| L-1 | 트래킹 코드 자동생성 | 12자리 영숫자 코드 생성 확인 | P0 |
| L-2 | 공개 URL 표시 | /public/court-reporter/tracking/{code} 형태 URL 제공 | P0 |
| L-3 | URL 복사 | 클립보드 복사 기능 정상 동작 | P1 |
| L-4 | 기존 코드 조회 | 이미 생성된 의뢰의 trackingCode 표시 | P1 |

---

## 4. STT 변환 (/pro/court-reporter/work/stt)

### 기능 설명
FastAPI 연동 음성→텍스트 변환, Clova/Whisper 모델 선택, 비동기 처리

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| S-1 | STT 모델 선택 | Clova/Whisper 선택 UI | P0 |
| S-2 | 변환 시작 | POST /transcription/transcribe-audio 호출 성공 | P0 |
| S-3 | 비동기 폴링 | STT_POLL_MS(8초) 간격 폴링, 진행률 표시 | P0 |
| S-4 | 변환 완료 처리 | segmentsJson 저장, transcript 생성 | P0 |
| S-5 | 변환 실패 처리 | 최대 3회 재시도 후 에러 표시 | P1 |
| S-6 | 화자수 감지 | speakerCount 필드 정상 저장 | P1 |
| S-7 | 대용량 파일 처리 | 1시간+ 오디오 파일 STT 정상 동작 | P2 |

---

## 5. 속기록 편집 (/pro/court-reporter/work/edit)

### 기능 설명
V7 블록 에디터, 일반 텍스트 편집, 멀티버전 관리, 최종 확정

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| E-1 | 트랜스크립트 목록 표시 | 해당 job의 모든 transcript 버전 목록 | P0 |
| E-2 | V7 에디터 로드 | transcriptionV7Json이 있을 때 블록 에디터 렌더링 | P0 |
| E-3 | 일반 텍스트 편집 | transcriptionEdited 텍스트 수정 및 저장 | P0 |
| E-4 | 새 버전 생성 | 수정 저장 시 version 자동 증가 | P1 |
| E-5 | 최종 확정 (isFinal) | isFinal=true 설정 → 이후 수정 불가/경고 | P0 |
| E-6 | 5MB 제한 | V7 JSON이 5MB 초과 시 경고/차단 | P2 |
| E-7 | STT→V7 변환 | sttToV7Document.ts 유틸로 세그먼트→블록 변환 | P1 |

---

## 6. 일정 관리 (/pro/court-reporter/schedule)

### 기능 설명
월별 캘린더 뷰, 일정별 의뢰 표시, 새 의뢰 생성

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| SC-1 | 캘린더 렌더링 | 현재 월 기준 달력 그리드 정상 표시 | P0 |
| SC-2 | 월 이동 (이전/다음) | ChevronLeft/Right 클릭 → 월 변경 및 데이터 갱신 | P0 |
| SC-3 | "오늘" 버튼 | Today 아이콘 클릭 → 현재 월로 복귀 | P1 |
| SC-4 | 일정 표시 | eventDate에 해당하는 셀에 의뢰 제목 + 상태 Chip 표시 | P0 |
| SC-5 | 일별 최대 3건 표시 | CALENDAR_ITEMS_PER_DAY=3 초과 시 "+N건" 표시 | P1 |
| SC-6 | 시간 표시 | formatTime으로 HH:MM 표시 (00:00은 공백) | P2 |
| SC-7 | 의뢰 클릭 → 상세 | 캘린더 내 의뢰 클릭 시 DetailDialog 오픈 | P0 |
| SC-8 | 새 의뢰 생성 | Add 버튼 → CreateDialog (eventDate 프리필) | P1 |
| SC-9 | 상태별 색상 | STATUS_COLOR 매핑대로 칩 색상 표시 | P2 |

---

## 7. 수수료 관리 (/pro/court-reporter/fee)

### 기능 설명
수수료 목록, 상태별 필터, 인라인 상태 변경, 금액 표시, 날짜 필터

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| F-1 | 수수료 목록 로드 | 전체 jobs 목록에서 수수료 정보 테이블 렌더링 | P0 |
| F-2 | 상태 필터 | 전체/미청구/청구완료/수납완료/취소 탭 필터 | P0 |
| F-3 | 검색 (의뢰인/제목) | TextField 입력 → 실시간 필터링 | P1 |
| F-4 | 날짜 범위 필터 | startDate ~ endDate 범위 필터 적용 | P1 |
| F-5 | 금액 표시 형식 | formatMoney: null→'-', 값→'1,000원' 로케일 포맷 | P0 |
| F-6 | 인라인 상태 변경 | 상태 칩 클릭 → Menu → 유효 전이만 표시 | P0 |
| F-7 | 상태 전이 규칙 | PENDING→[BILLED,CANCELLED], BILLED→[PAID,PENDING,CANCELLED], PAID→[], CANCELLED→[PENDING] | P0 |
| F-8 | PATCH 수수료 API | PATCH /api/court-reporter/jobs/{id}/fee 호출 성공 | P0 |
| F-9 | 청구일/결제일 표시 | feeBilledAt, feePaidAt 날짜 정상 표시 | P1 |
| F-10 | 수수료 메모 | feeNote 표시 및 수정 | P2 |
| F-11 | CSV/Excel 다운로드 | Download 버튼 동작 확인 | P2 |

---

## 8. 의뢰인 관리 (/pro/court-reporter/client)

### 기능 설명
ClientListPage 공유 컴포넌트 사용, 의뢰인 목록/상세/수정

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| C-1 | 의뢰인 목록 로드 | client_name, phone, email 필드 테이블 표시 | P0 |
| C-2 | 의뢰인 검색 | 이름/전화번호/이메일 검색 | P1 |
| C-3 | 의뢰인 상세 조회 | /:clientId 라우트로 상세 페이지 이동 | P0 |
| C-4 | 기존 사용자 연결 | lemon_user_id 매핑 (리걸몬스터 기존 회원 연동) | P1 |
| C-5 | 의뢰인별 의뢰 이력 | 해당 의뢰인의 과거 의뢰 목록 표시 | P2 |

---

## 9. 문서관리 (/pro/court-reporter/docs)

### 기능 설명
LDrive 연동 문서 저장소, 공유 게시판, 첨부파일, 열람 이력

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| DC-1 | 레몬 문서 목록 | /docs/lemon 접근 시 개인 문서 목록 표시 | P0 |
| DC-2 | 공용 문서 게시판 | /docs/shared 공유 문서 열람 | P1 |
| DC-3 | 첨부 파일 조회 | /docs/attachments 의뢰별 첨부파일 모아보기 | P1 |
| DC-4 | 문서 열람 이력 | /docs/history 접근 로그 표시 | P2 |
| DC-5 | 문서 상세 보기 | /:id 파라미터로 개별 문서 접근 | P0 |
| DC-6 | LDrive 파일 다운로드 | ldriveFileId 기반 파일 다운로드 정상 | P0 |

---

## 10. 계약관리 (/pro/court-reporter/contract)

### 기능 설명
ContractListV2 공유 컴포넌트, 계약현황/템플릿 관리

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| CT-1 | 계약 현황 목록 | /contract/status 접근 시 계약 리스트 표시 | P0 |
| CT-2 | 계약서 템플릿 | /contract/template 사용 가능 템플릿 목록 | P1 |
| CT-3 | 계약 상세 | /contract/status/:id 개별 계약 조회 | P0 |
| CT-4 | 의뢰별 계약 연결 | GET /api/court-reporter/jobs/{jobId}/contract 정상 응답 | P0 |
| CT-5 | 계약 생성/수정 | 새 계약 작성 및 기존 계약 편집 | P1 |

---

## 11. 작업 추적 — 공개 (/public/court-reporter/tracking)

### 기능 설명
인증 없이 접근, 트래킹 코드로 작업 상태 조회, Stepper UI

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| T-1 | 페이지 로드 (코드 없이) | 코드 입력 TextField + 조회 버튼 표시 | P0 |
| T-2 | URL 파라미터 자동 조회 | /tracking/ABC123 접근 시 자동 검색 실행 | P0 |
| T-3 | 유효 코드 조회 | 트래킹 정보 표시: 제목, 이벤트 유형, 날짜, 장소, 상태 | P0 |
| T-4 | Stepper 진행 표시 | 접수→작업중→완료→납품 4단계 Stepper 현재 위치 표시 | P0 |
| T-5 | 무효 코드 에러 | 404 시 "해당 트래킹 코드를 찾을 수 없습니다" 표시 | P1 |
| T-6 | 취소 상태 표시 | CANCELLED 시 Stepper step=-1 처리 | P1 |
| T-7 | 납품 파일 여부 | hasFinalFile=true 시 안내 표시 | P2 |
| T-8 | 인증 불필요 확인 | 로그아웃 상태에서 접근 가능 | P0 |
| T-9 | 코드 대소문자 무시 | 소문자 입력 → toUpperCase() 정규화 | P2 |

---

## 12. 공통/횡단 테스트

### 테스트 항목
| # | 테스트 케이스 | 검증 기준 | 우선순위 |
|---|-------------|-----------|----------|
| X-1 | 사이드바 메뉴 표시 | 속기사 타입 로그인 시 모든 메뉴 항목 노출 | P0 |
| X-2 | 라우팅 정상 동작 | 모든 /pro/court-reporter/* 경로 접근 가능 | P0 |
| X-3 | 비속기사 접근 차단 | AdminUserIdGate / 타입 체크로 비권한 사용자 차단 | P0 |
| X-4 | i18n 메뉴명 표시 | sidebar.json 기반 메뉴 한글/영문 정상 | P1 |
| X-5 | 다크모드 전체 | 모든 페이지 다크모드 색상 정상 | P2 |
| X-6 | 모바일 반응형 전체 | 모든 페이지 모바일 레이아웃 적응 | P1 |
| X-7 | API 에러 공통 처리 | 401→로그인 리다이렉트, 403→권한없음, 500→에러 표시 | P1 |
| X-8 | ErpPageLayout 통합 | 모든 페이지가 ErpPageLayout 래퍼 사용 | P2 |

---

## E2E 핵심 시나리오 (Golden Path)

### 시나리오 1: 의뢰→STT→편집→납품 전체 플로우
1. 대시보드 → "새 의뢰" → 의뢰 정보 입력 → 저장
2. 작업 목록에서 의뢰 확인 → 상태: PENDING
3. 파일 업로드 (오디오 파일)
4. STT 변환 시작 → 폴링 → 완료
5. 속기록 편집 → 수정 → 최종 확정
6. 상태: COMPLETED → 납품 파일 업로드 → 상태: DELIVERED
7. 수수료: PENDING → BILLED → PAID

### 시나리오 2: 의뢰인 트래킹 플로우
1. 의뢰 생성 시 trackingCode 자동 발급
2. 공개 URL (/public/court-reporter/tracking/CODE) 접근
3. 상태 변경 시 트래킹 페이지에 실시간 반영 확인

### 시나리오 3: 일정 기반 작업 관리
1. 일정 관리 → 이번 주 예정 의뢰 확인
2. 의뢰 클릭 → 상세 → 상태 변경 (PENDING → IN_PROGRESS)
3. 대시보드에서 통계 갱신 확인

---

## 테스트 우선순위 요약

| 우선순위 | 건수 | 설명 |
|----------|------|------|
| P0 (필수) | 38건 | 핵심 기능, 상용 출시 전 반드시 통과 |
| P1 (중요) | 25건 | 사용성 핵심, 출시 전 강력 권장 |
| P2 (개선) | 16건 | 폴리시/엣지케이스, 출시 후 개선 가능 |
| **총계** | **79건** | |

---

## 자동화 테스트 제안

### Unit Test 대상
- `courtReporterConstants.ts` — FEE_VALID_TRANSITIONS 전이 규칙
- `sttToV7Document.ts` — STT 세그먼트→V7 블록 변환
- `useHangulSebulsik.ts` — 세벌식 입력 처리
- `formatMoney()`, `formatTime()` — 포맷 함수

### Integration Test 대상
- 의뢰 CRUD API 호출 (axiosInstance mock)
- STT 폴링 로직 (타이머 mock)
- 수수료 상태 전이 API

### E2E Test 대상 (Cypress/Playwright)
- 시나리오 1 전체 플로우
- 공개 트래킹 페이지 접근
- 권한 차단 검증
