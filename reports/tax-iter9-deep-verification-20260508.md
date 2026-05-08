# ITERATION 9: 세무사 메뉴 심층 교차 검증

**날짜:** 2026-05-08
**검증 대상:** (1) API 불일치 9건 재확인 + 에러 처리 검증, (2) "매칭 성공" 엔드포인트 데이터 흐름 정합성

---

## 1. 핵심 발견 요약

| 구분 | 발견 | 심각도 |
|------|------|--------|
| **신규 발견** | Tax Filing 필드명 불일치 6건 + status enum 완전 불일치 | 🔴 CRITICAL |
| **신규 발견** | Tax Filing `taxPeriod` 필수 필드 누락 (프론트 미전송) | 🔴 CRITICAL |
| **재확인** | API 미구현 9건 모두 확인 (Spring 컨트롤러 부재) | 🔴 CRITICAL |
| **신규 발견** | 기장대리 3개 페이지 에러 무시 + mock 데이터 표시 | 🟡 HIGH |
| **신규 발견** | Tax Invoice `@ValidBusinessNumber` 프론트 미검증 | 🟡 MEDIUM |

**Iteration 8 보고서 정정:** Tax Filing은 "매칭 성공 6/6"으로 보고되었으나, 실제로는 경로만 일치하고 **파라미터/필드명/enum이 불일치**하여 CRUD 기능이 정상 동작하지 않음.

---

## 2. 🔴 신규 CRITICAL: Tax Filing 필드명 불일치

### 2.1 조회 파라미터 불일치 (GET /api/erp/tax/filings)

| 프론트엔드 파라미터 | Spring 파라미터 | 결과 |
|---------------------|----------------|------|
| `clientId` | `contractId` | ❌ 백엔드가 무시 (null 처리) |
| `filingType` | `taxType` | ❌ 백엔드가 무시 (null 처리) |
| `taxPeriodYear` | `year` | ❌ 백엔드가 무시 (null 처리) |
| `status` | `status` | ✅ 일치 (단, enum 값 불일치) |

**영향:** 필터가 전혀 동작하지 않음. 모든 조회가 필터 없이 전체 데이터 반환.

### 2.2 생성/수정 요청 body 불일치 (POST/PUT)

| 프론트엔드 필드 | Spring 필드 | 상태 |
|----------------|-------------|------|
| `clientId` | `contractId` | ❌ 불일치 |
| `filingType` | `taxType` | ❌ 불일치 |
| `taxPeriodYear` | `fiscalYear` | ❌ 불일치 |
| (없음) | `taxPeriod` (required) | ❌ 누락 — 400 Bad Request 발생 |
| `taxableAmount` | `taxBaseAmount` | ❌ 불일치 |
| `calculatedTax` | `taxAmount` | ❌ 불일치 |
| `payableAmount` | `paidAmount` | ❌ 불일치 |
| `memo` | `notes` | ❌ 불일치 |
| `dueDate` | `deadline` | ❌ 불일치 |

**영향:** 신고 생성/수정 시 필수 필드 누락으로 400 에러 또는 모든 금액 필드가 null로 저장됨.

### 2.3 Status Enum 완전 불일치

| 프론트엔드 | 백엔드 |
|-----------|--------|
| `NOT_STARTED` | `PENDING` |
| `IN_PROGRESS` | `PREPARED` |
| `REVIEW` | (없음) |
| `SUBMITTED` | `FILED` |
| `AMENDED` | (없음) |
| (없음) | `PAID` |
| (없음) | `OVERDUE` |

**영향:** 상태 필터링 불가, 상태 변경 시 백엔드 validation 실패 가능.

---

## 3. 🔴 재확인: API 미구현 9건

Spring 코드베이스 전체 검색으로 재확인 완료. 모든 엔드포인트가 확실히 미구현.

| 카테고리 | 미구현 수 | 검색 키워드 | 결과 |
|---------|----------|------------|------|
| 성실신고 확인 | 7개 | `honest-filing`, `honestFiling` | 0건 |
| AI 분석 | 2개 | `taxaccountant/ai` | 0건 |
| 홈택스 연동 | 2개 | `integrations/hometax` | 0건 |
| 기장대리 회계 | 4개 | `accountant/accounts`, `accountant/transactions`, `accountant/ledger`, `accountant/journal` | 0건 |

**참고:** `ErpAccountantWorkpaperController`는 존재하지만 감사조서(workpaper) 관련 엔드포인트만 제공. 회계장부(accounts/transactions/ledger/journal) 엔드포인트는 없음.

---

## 4. 🟡 에러 처리 검증 (미구현 API 영향받는 6개 페이지)

| 페이지 | try-catch | 에러 상태 | 사용자 메시지 | 크래시 위험 | 등급 |
|--------|-----------|----------|-------------|-----------|------|
| TaxHonestFilingPage | ✅ | ✅ | ✅ 재시도 버튼 | 없음 | A+ |
| TaxAIPage | ✅ | ✅ | ✅ 에러 배너 | 없음 | A |
| TaxSettingsPage | ✅ | ⚠️ | ⚠️ 무응답 | 없음 | C+ |
| TaxTransactionEntryPage | ✅ | ❌ | ❌ 낙관적 업데이트 | 없음 | C |
| TaxLedgerPage | ✅ | ❌ | ❌ mock 데이터 표시 | 없음 | C |
| TaxJournalPage | ✅ | ❌ | ❌ mock 데이터 표시 | 없음 | C |

**핵심 이슈:**
- 기장대리 3페이지(Entry/Ledger/Journal): API 404 시 mock 데이터를 표시하여 사용자가 **실제 데이터로 착각** 가능
- TaxSettingsPage: AI 통계 실패를 무시하고 "—" 표시
- TaxTransactionEntryPage: 저장 실패 시 낙관적 업데이트로 저장된 것처럼 보임

---

## 5. ✅ 정상 매칭 엔드포인트 심층 검증

### 5.1 Tax Invoice — ✅ 정상 (경미한 이슈 1건)
- 경로: 7/7 일치
- 파라미터: 모두 일치
- DTO 필드: 모두 일치
- **경미:** 프론트엔드에서 `counterpartBusinessNumber` 검증 없음 (백엔드 `@ValidBusinessNumber` 의존)

### 5.2 Tax Filing — ❌ 심각한 불일치 (위 2번 참조)
- 경로: 6/6 일치
- **파라미터: 3/6 불일치**
- **DTO 필드: 8/12 불일치**
- **Status enum: 완전 불일치**

### 5.3 Tax Payroll — ✅ 정상
- 경로: 7/7 일치
- 파라미터: 모두 일치
- DTO 필드: 모두 일치
- Status: `DRAFT | CONFIRMED | PAID` — 백엔드 검증 없으나 사용상 문제 없음

---

## 6. 수정 우선순위 (업데이트)

### CRITICAL (상용 전 필수)
1. **Tax Filing 필드명 통일** — 프론트엔드 또는 백엔드 중 하나를 기준으로 정렬
2. **Tax Filing status enum 통일**
3. **성실신고 확인 컨트롤러 신규 개발**
4. **기장대리 회계 컨트롤러 신규 개발**

### HIGH
5. **AI 분석 백엔드 구현**
6. **홈택스 연동 백엔드 구현**
7. **기장대리 3페이지 에러 처리 개선** — mock 데이터 대신 "API 미연결" 안내

### MEDIUM
8. **Tax Invoice 사업자번호 프론트 검증 추가**
9. **미사용 백엔드 엔드포인트 연결** (filings/upcoming, filings/generate)

---

## 7. 전체 진행 상황

| 반복 | 검증 내용 | 주요 발견 |
|------|----------|----------|
| 1-4 | 서버/경로/인증 | 16개 경로 200 OK, HTTPS 필수 |
| 5-8 | 코드 레벨 정적 검증 | API 미구현 9건 발견 |
| **9** | **심층 교차 검증** | **Tax Filing 필드 불일치 (신규), 에러 처리 미흡 4건** |

**다음 반복(10):** 나머지 "매칭 성공" 엔드포인트 (Contract, Withholding, ClientOrganization) 심층 데이터 흐름 검증
