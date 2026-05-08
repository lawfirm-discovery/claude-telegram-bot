# ITERATION 10: 세무사 메뉴 최종 교차 검증 — 나머지 매칭 엔드포인트

**날짜:** 2026-05-08
**검증 대상:** Contract, Withholding, ClientOrganization, Payroll의 프론트-백엔드 필드/파라미터 심층 매핑

---

## 1. 핵심 결론

| 모듈 | 경로 일치 | 파라미터 일치 | DTO 필드 일치 | 종합 |
|------|----------|-------------|-------------|------|
| Contract (수임계약) | ✅ 5/5 | ✅ 완전 | ✅ 완전 | ✅ PASS |
| Withholding (원천징수) | ✅ 6/6 | ✅ 완전 | ✅ 완전 | ✅ PASS |
| ClientOrganization (거래처) | ✅ 5/5 | ✅ 완전 | ✅ 완전 (날짜 자동변환) | ✅ PASS |
| Payroll (급여관리) | ✅ 6/6 | ✅ 완전 | ✅ 완전 | ✅ PASS |
| **Tax Filing (신고관리)** | ✅ 6/6 | ❌ 3/6 | ❌ 4/12 | ❌ FAIL |
| Tax Invoice (세금계산서) | ✅ 7/7 | ✅ 완전 | ✅ 완전 (경미 1건) | ✅ PASS |

**결론:** 6개 모듈 중 **Tax Filing만 유일하게 CRITICAL 불일치**. 나머지 5개는 프로덕션 레디.

---

## 2. Contract (수임계약) — ✅ PASS

### API 매핑
| 함수 | 메서드 | 프론트 경로 | 백엔드 경로 | 상태 |
|------|--------|-----------|-----------|------|
| getContracts | GET | /api/erp/tax/contracts | /api/erp/tax/contracts | ✅ |
| createContract | POST | /api/erp/tax/contracts | /api/erp/tax/contracts | ✅ |
| updateContract | PUT | /api/erp/tax/contracts/{id} | /api/erp/tax/contracts/{id} | ✅ |
| terminateContract | POST | /api/erp/tax/contracts/{id}/terminate | /api/erp/tax/contracts/{id}/terminate | ✅ |
| deleteContract | DELETE | /api/erp/tax/contracts/{id} | /api/erp/tax/contracts/{id} | ✅ |

### DTO 필드 비교
| 프론트엔드 | 백엔드 | 일치 |
|-----------|--------|------|
| clientId | clientId | ✅ |
| contractStartDate | contractStartDate | ✅ |
| contractEndDate | contractEndDate | ✅ |
| monthlyFee | monthlyFee | ✅ |
| services | services | ✅ |
| memo | memo | ✅ |

---

## 3. Withholding (원천징수) — ✅ PASS

### API 매핑
| 함수 | 메서드 | 경로 | 상태 |
|------|--------|-----|------|
| getWithholdings | GET | /api/erp/tax/withholding | ✅ |
| getWithholdingMonthlySummary | GET | /api/erp/tax/withholding/summary/monthly | ✅ |
| createWithholding | POST | /api/erp/tax/withholding | ✅ |
| updateWithholding | PUT | /api/erp/tax/withholding/{id} | ✅ |
| deleteWithholding | DELETE | /api/erp/tax/withholding/{id} | ✅ |
| reportWithholding | POST | /api/erp/tax/withholding/report | ✅ |

### DTO 필드 — 전부 일치
clientId, withholdingType, taxPeriodYear, taxPeriodMonth, recipientName, recipientIdNumber, grossAmount, taxableAmount, incomeTaxAmount, localTaxAmount, totalTaxAmount, netAmount, paymentDate, isReported, memo

---

## 4. ClientOrganization (거래처) — ✅ PASS

수임계약(Contract)과 동일한 `/api/erp/tax/contracts` 엔드포인트 공유.
`getActiveClients()` → GET `/api/erp/tax/contracts/active` 추가 확인.

### 경미 사항
- 프론트: `contractStartDate` = String (ISO) ↔ 백엔드: LocalDate — Spring 자동 변환으로 문제 없음

---

## 5. Payroll (급여관리) — ✅ PASS

### API 매핑
| 함수 | 메서드 | 경로 | 상태 |
|------|--------|-----|------|
| getPayrolls | GET | /api/erp/tax/payroll | ✅ |
| getPayrollMonthlySummary | GET | /api/erp/tax/payroll/summary/monthly | ✅ |
| createPayroll | POST | /api/erp/tax/payroll | ✅ |
| updatePayroll | PUT | /api/erp/tax/payroll/{id} | ✅ |
| confirmPayroll | POST | /api/erp/tax/payroll/{id}/confirm | ✅ |
| downloadPayrollPdf | GET | /api/erp/tax/payroll/{id}/pdf | ✅ |

### DTO 필드 — 전부 일치
baseSalary, allowance, bonus, grossPay, incomeTax, localTax, healthInsurance, nationalPension, employmentInsurance, totalDeduction, netPay, paymentMonth, contractId, employeeName, position, status

---

## 6. 전체 세무사 메뉴 검증 종합 (Iteration 1~10)

### 프론트-백엔드 API 정합성 최종 결과

| 모듈 | API 수 | 경로 일치 | 필드 일치 | 에러 처리 | 종합 등급 |
|------|--------|----------|----------|----------|----------|
| Contract | 5 | 5/5 | ✅ | A | ✅ PASS |
| Withholding | 6 | 6/6 | ✅ | A | ✅ PASS |
| Client/Org | 5 | 5/5 | ✅ | A | ✅ PASS |
| Payroll | 6 | 6/6 | ✅ | A | ✅ PASS |
| Tax Invoice | 7 | 7/7 | ✅ (경미1) | A | ✅ PASS |
| **Tax Filing** | **6** | **6/6** | **❌ 8/12불일치** | **B** | **❌ FAIL** |
| Honest Filing | 7 | — | — | A+ | ❌ 미구현 |
| AI Analysis | 2 | — | — | A | ❌ 미구현 |
| Hometax Integ. | 2 | — | — | — | ❌ 미구현 |
| Bookkeeping (4pg) | 4 | — | — | C | ❌ 미구현 |

### 수정 필요 사항 최종 정리

#### 🔴 CRITICAL (상용 전 필수 — 2건)
1. **Tax Filing 필드명/enum 통일** — 프론트 9개 필드명을 백엔드에 맞추거나 그 반대
2. **Tax Filing status enum 통일** — NOT_STARTED↔PENDING, IN_PROGRESS↔PREPARED 등 매핑

#### 🟠 HIGH (기능 미구현 — 4건)
3. 성실신고 확인(Honest Filing) Spring 컨트롤러 신규 개발 (7 API)
4. 기장대리 회계(Bookkeeping) Spring 컨트롤러 신규 개발 (4 API)
5. AI 분석 백엔드 구현 (2 API)
6. 홈택스 연동 백엔드 구현 (2 API)

#### 🟡 MEDIUM (에러 처리 — 3건)
7. 기장대리 3페이지: API 404 시 mock 데이터 대신 "API 미연결" 안내
8. Tax Invoice: 사업자번호 프론트 검증 추가
9. Tax Filing: 에러 메시지 개선

---

## 7. 검증 완료 선언

10회 반복 검증(서버 접근성 → HTTP 상태 → 페이지 콘텐츠 → 코드 정적 분석 → API 매핑 → 심층 필드 교차 검증)을 통해 세무사 메뉴 전체의 프론트-백엔드 정합성을 확인 완료.

**정상 5개 모듈 (22 API)**: 프로덕션 레디
**CRITICAL 1개 모듈 (6 API)**: Tax Filing 필드명 수정 필요
**미구현 4개 모듈 (15 API)**: 백엔드 개발 필요
