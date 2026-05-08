# ITERATION 8: 세무사 메뉴 API 엔드포인트 매핑 검증

**날짜:** 2026-05-08
**검증 대상:** 프론트엔드 API 호출 ↔ Spring 컨트롤러 매핑 정합성

---

## 1. 검증 결과 요약

| 항목 | 수치 |
|------|------|
| 프론트엔드 API 호출 총 수 | 52개 |
| Spring 컨트롤러 엔드포인트 총 수 | 85+ |
| **매칭 성공** | 42개 |
| **❌ 프론트엔드 호출 → 백엔드 미구현** | **9개** |
| ⚠️ 백엔드 구현 → 프론트엔드 미사용 | 4개 |

---

## 2. ❌ 백엔드 미구현 엔드포인트 (CRITICAL)

프론트엔드에서 호출하지만 Spring 컨트롤러가 존재하지 않는 엔드포인트.
사용자가 해당 기능을 사용하면 **404 또는 500 에러 발생**.

### 2.1 성실신고 확인 (HonestFiling) — 5개 엔드포인트

| 메서드 | 엔드포인트 | 호출 파일 |
|--------|-----------|----------|
| GET | `/api/erp/tax/honest-filing` | TaxHonestFilingPage.tsx |
| GET | `/api/erp/tax/honest-filing/{targetId}` | taxAccountant.api.ts |
| POST | `/api/erp/tax/honest-filing` | taxAccountant.api.ts |
| POST | `/api/erp/tax/honest-filing/{targetId}/start-review` | taxAccountant.api.ts |
| POST | `/api/erp/tax/honest-filing/{targetId}/complete-review` | taxAccountant.api.ts |
| POST | `/api/erp/tax/honest-filing/{targetId}/issue-certificate` | taxAccountant.api.ts |
| GET | `/api/erp/tax/honest-filing/{targetId}/certificate/download` | taxAccountant.api.ts |

**영향:** 성실신고 확인 메뉴 전체 기능 불능

### 2.2 AI 분석 — 2개 엔드포인트

| 메서드 | 엔드포인트 | 호출 파일 |
|--------|-----------|----------|
| GET | `/api/erp/taxaccountant/ai/stats` | TaxSettingsPage.tsx |
| POST | `/api/erp/taxaccountant/ai/analyze` | TaxAIPage.tsx |

**영향:** AI 분석 페이지 및 설정의 AI 통계 불능

### 2.3 홈택스 연동 — 2개 엔드포인트

| 메서드 | 엔드포인트 | 호출 파일 |
|--------|-----------|----------|
| POST | `/api/erp/taxaccountant/integrations/hometax/connect` | TaxSettingsPage.tsx |
| DELETE | `/api/erp/taxaccountant/integrations/{integrationId}` | TaxSettingsPage.tsx |

**영향:** 세무 설정 페이지의 홈택스 연동 기능 불능

### 2.4 기장대리 (Bookkeeping) — 4개 엔드포인트

| 메서드 | 엔드포인트 | 호출 파일 |
|--------|-----------|----------|
| GET | `/api/erp/accountant/accounts` | TaxTransactionEntryPage.tsx |
| GET/POST | `/api/erp/accountant/transactions` | TaxTransactionEntryPage.tsx |
| GET | `/api/erp/accountant/ledger` | TaxLedgerPage.tsx |
| GET | `/api/erp/accountant/journal` | TaxJournalPage.tsx |

**영향:** 기장대리 하위 메뉴(거래 입력, 분개장, 계정별원장) 전체 불능
**참고:** ErpAccountantWorkpaperController는 존재하지만 accounts/transactions/ledger/journal 엔드포인트 없음

---

## 3. ⚠️ 프론트엔드 미사용 백엔드 엔드포인트

Spring에 구현되어 있으나 프론트엔드에서 호출하지 않는 엔드포인트.

| 메서드 | 엔드포인트 | 컨트롤러 |
|--------|-----------|----------|
| GET | `/api/erp/tax/filings/upcoming` | ErpTaxFilingController |
| POST | `/api/erp/tax/filings/generate` | ErpTaxFilingController |
| POST | `/api/erp/tax/filings/{filingId}/pay` | ErpTaxFilingController |
| - | `/api/tax-management/clients/*` (16개) | TaxClientController (구 specialist 메뉴) |

**영향:** 기능 낭비이나 에러 아님. `/filings/upcoming`과 `/filings/generate`는 대시보드나 캘린더에서 활용 가능.

---

## 4. ✅ 매칭 성공 컨트롤러

| 프론트엔드 API 그룹 | Spring 컨트롤러 | 엔드포인트 수 |
|---------------------|----------------|--------------|
| `/api/erp/tax/contracts` | ErpTaxContractController | 8/8 ✅ |
| `/api/erp/tax/invoices` | ErpTaxInvoiceController | 8/8 ✅ |
| `/api/erp/tax/filings` | ErpTaxFilingController | 6/6 ✅ |
| `/api/erp/tax/withholding` | ErpTaxWithholdingController | 6/6 ✅ |
| `/api/erp/tax/payroll` | ErpTaxPayrollController | 7/7 ✅ |
| `/api/erp/tax/clients/*/organization` | ErpTaxClientOrganizationController | 5/5 ✅ |
| `/api/consultation-requests` | (공통 상담 컨트롤러) | 2/2 ✅ |
| 대시보드 (contracts+filings 재사용) | - | 3/3 ✅ |

---

## 5. 라우트 ↔ 메뉴 ↔ 컴포넌트 정합성

| 메뉴 항목 | 라우트 경로 | 컴포넌트 | Lazy Load | 상태 |
|-----------|-----------|----------|-----------|------|
| 세무 대시보드 | `/tax/dashboard` | TaxDashboardPage | ✅ | ✅ 정상 |
| 거래처 관리 | `/tax/clients` | TaxClientManagementPage | ✅ | ✅ 정상 |
| 기장대리 > 거래 입력 | `/tax/bookkeeping/entry` | TaxTransactionEntryPage | ✅ | ❌ API 없음 |
| 기장대리 > 분개장 | `/tax/bookkeeping/journal` | TaxJournalPage | ✅ | ❌ API 없음 |
| 기장대리 > 계정별원장 | `/tax/bookkeeping/ledger` | TaxLedgerPage | ✅ | ❌ API 없음 |
| 세금계산서 | `/tax/invoice` | TaxInvoicePage | ✅ | ✅ 정상 |
| 신고 관리 | `/tax/filing` | TaxFilingPage | ✅ | ✅ 정상 |
| 원천세 관리 | `/tax/withholding` | TaxWithholdingPage | ✅ | ✅ 정상 |
| 급여 관리 | `/tax/payroll` | TaxPayrollPage | ✅ | ✅ 정상 |
| 수임계약 관리 | `/tax/contracts` | TaxContractPage | ✅ | ✅ 정상 |
| 세무 상담 | `/tax/consultation` | TaxConsultationPage | ✅ | ✅ 정상 |
| 기업자문 | `/tax/advisory` | ProfessionalAdvisoryRequestListPage | ✅ | ✅ 정상 |
| 성실신고 확인 | `/tax/honest-filing` | TaxHonestFilingPage | ✅ | ❌ API 없음 |
| 리포트 | `/tax/reports` | TaxReportsPage | ✅ | △ 확인 필요 |
| AI 분석 | `/tax/ai` | TaxAIPage | ✅ | ❌ API 없음 |
| 세무 설정 | `/tax/settings` | TaxSettingsPage | ✅ | ❌ 부분 (AI/연동 API 없음) |

---

## 6. 권한 제어 검증

| 검증 항목 | 결과 |
|-----------|------|
| dtype='semusa' 매칭 | ✅ `UserType.SEMUSA` 정상 |
| AdminUserIdGate 적용 | ✅ 모든 메뉴 항목에 적용 |
| ADMIN_USER_IDS (5,30,72) | ✅ 관리자 테스트 접근 가능 |
| 이중 검증 (메뉴+페이지) | ✅ MenuFactoryV2 + 개별 페이지 Gate |

---

## 7. 결론 및 권고

### CRITICAL (상용 전 필수 해결)
1. **성실신고 확인 컨트롤러 신규 개발 필요** — `ErpTaxHonestFilingController` 생성
2. **기장대리 회계 컨트롤러 신규 개발 필요** — accounts, transactions, ledger, journal 엔드포인트 추가

### HIGH (기능 완성도)
3. **AI 분석 백엔드 구현** — `/api/erp/taxaccountant/ai/*` 엔드포인트 추가
4. **홈택스 연동 백엔드 구현** — `/api/erp/taxaccountant/integrations/*` 엔드포인트 추가

### MEDIUM (기능 활용도 개선)
5. **미사용 백엔드 연결** — `/filings/upcoming`을 대시보드에, `/filings/generate`를 캘린더에 연동

### DTO 존재 확인
- `ErpTaxDashboardDTO` — DTO는 존재하나 전용 컨트롤러 없음 (현재 contracts+filings 조합으로 대시보드 구현중)
