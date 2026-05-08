# ITERATION 6/20 — 세무사 메뉴 검증: 상담·사건관리·API 엔드포인트

**일시:** 2026-05-08
**검증 범위:** 상담 컴포넌트, 사건/계약 관리, 프론트-백엔드 API 매칭

---

## 1. 검증 결과 요약

| 항목 | 결과 | 비고 |
|------|------|------|
| 메뉴 항목 수 | 14개 | 모두 isCompleted: true |
| 프론트엔드 API 함수 | 53개 | taxAccountant.api.ts + consultationRequest.api.ts |
| 백엔드 컨트롤러 매칭 | 46/53 (87%) | 7개 미구현 (성실신고) |
| 컴포넌트 파일 수 | 60+ | 모두 정상 import/export |
| TypeScript 에러 | 0건 | |
| 누락 import | 0건 | |

---

## 2. 모듈별 검증 상세

### A. 세무 상담 (Tax Consultation) ✅
- **경로:** `/tax/consultation`
- **파일:** `TaxConsultationPage.tsx` (271줄) + 하위 컴포넌트 3개
- **기능:** 목록(페이징/검색/필터), 상세 모달, 상태 변경(대기→진행→완료/취소), 상담링크 생성
- **API:** `consultation-requests/my-requests` (GET, PATCH) — 백엔드 매칭 ✅
- **반응형:** 모바일 전체화면 모달, backdrop blur ✅
- **다크모드:** 지원 ✅

### B. 수임계약 관리 (Contract) ✅
- **경로:** `/tax/contracts`
- **파일:** `TaxContractPage.tsx` (444줄) + `TaxContractDetailModal.tsx`
- **기능:** CRUD 전체, 상태관리(활성/중단/해지), 서비스 유형 6종, 통계 카드, 검색/필터
- **API:** `/api/erp/tax/contracts` (7 endpoints) — 백엔드 매칭 ✅
- **DTO 일치:** `TaxContract` ↔ `ErpTaxContractDTO` ✅

### C. 세금계산서 (Invoice) ✅
- **경로:** `/tax/invoice`
- **API:** 8 endpoints — 백엔드 매칭 ✅ (`ErpTaxInvoiceController`)
- **기능:** CRUD, 발행, 취소, PDF 다운로드, 월별 요약

### D. 신고 관리 (Filing) ✅
- **경로:** `/tax/filing`
- **API:** 9 endpoints — 백엔드 매칭 ✅ (`ErpTaxFilingController`)
- **기능:** CRUD, 제출, 기한 관리

### E. 원천세 관리 (Withholding) ✅
- **경로:** `/tax/withholding`
- **API:** 6 endpoints — 백엔드 매칭 ✅ (`ErpTaxWithholdingController`)

### F. 급여 관리 (Payroll) ✅
- **경로:** `/tax/payroll`
- **API:** 7 endpoints — 백엔드 매칭 ✅ (`ErpTaxPayrollController`)

### G. 성실신고 확인 (Honest Filing) ⚠️
- **경로:** `/tax/honest-filing`
- **API:** 7 endpoints — 백엔드 미구현 ❌
- **상태:** 프론트엔드에 UI 존재하지만 API는 목(mock) 데이터 반환
- **영향:** 기능 자체는 동작하지 않음 (데모/프로토타입 수준)

---

## 3. 발견된 이슈

### 이슈 #1: 성실신고 확인 백엔드 미구현 (중요도: 중)
- **위치:** `/api/erp/tax/honest-filing/*` (7 endpoints)
- **현상:** 프론트엔드에서 API 함수 정의는 있으나, Spring 백엔드에 대응 컨트롤러 없음
- **영향:** 해당 메뉴 접근 시 네트워크 에러 발생 가능
- **권장:** 백엔드 구현 또는 메뉴 비활성화

### 이슈 없음 (나머지 모듈)
- import/export 체인 정상
- DTO 타입 프론트-백 일치
- 반응형/다크모드 지원 확인
- i18n 키 패턴 일관성 (`p.taxaccountant.*`)

---

## 4. 파일 목록

### 프론트엔드 (핵심)
```
src/erp/pages/TaxAccountant/
├── Consultation/TaxConsultationPage.tsx (271줄)
├── Consultation/components/TaxConsultationDetailModal.tsx (261줄)
├── Consultation/components/TaxConsultationList.tsx (132줄)
├── Consultation/components/TaxConsultationLinkModal.tsx (233줄)
├── Contract/TaxContractPage.tsx (444줄)
├── Contract/components/TaxContractDetailModal.tsx (218줄)
├── common/TaxClientDropdown.tsx (189줄)
└── index.ts

src/erp/api/taxAccountant/
├── taxAccountant.api.ts (413줄, 53 API 함수)
└── taxAccountant.types.ts (471줄)

src/erp/layout/menu/ProfessionalMenuItems/
└── TaxAccountantMenuItems.tsx (14개 메뉴)
```

### 백엔드 (컨트롤러)
```
controller/erp/tax/
├── ErpTaxContractController.java ✅
├── ErpTaxInvoiceController.java ✅
├── ErpTaxFilingController.java ✅
├── ErpTaxWithholdingController.java ✅
├── ErpTaxPayrollController.java ✅
└── (ErpTaxHonestFilingController.java ❌ 미존재)

controller/consultation/
└── ConsultationRequestController.java ✅
```

---

## 5. 결론

세무사 모듈 14개 메뉴 중 **13개는 프론트-백 완전 구현**, **1개(성실신고)는 프론트만 구현**. 전체적으로 코드 품질 양호하고, TypeScript 에러·누락 import 없음. 상용 운영에 큰 문제 없으나, 성실신고 백엔드 구현 또는 메뉴 비활성화 조치 필요.
