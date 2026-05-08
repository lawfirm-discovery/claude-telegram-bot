# ERP 세무사(TAX_ACCOUNTANT) 메뉴 구조 분석

## 1. 사용자 타입 정의

| 파일 | 키 | 값 |
|------|-----|-----|
| `user.api.model.ts:30` | Role enum | `TAX_ACCOUNTANT = '세무사'` |
| `user.api.model.ts:68` | UserType enum | `SEMUSA = 'semusa'` (DB dtype) |
| `professional.types.ts:6` | ProfessionalType | `TAX_ACCOUNTANT = 'TAX_ACCOUNTANT'` |

## 2. 메뉴 정의 파일

**`src/erp/layout/menu/ProfessionalMenuItems/TaxAccountantMenuItems.tsx`** (400줄)

- `id: 'tax-accountant'`, `label: '세무사 전용'`
- `includeTypes: [UserModel.UserType.SEMUSA]`
- `includeUserIds: ADMIN_USER_IDS` (5, 30, 72)

### 메뉴 항목 (14개)

| # | 메뉴명 | 경로 | 하위메뉴 |
|---|--------|------|---------|
| 1 | 세무 대시보드 | `/tax/dashboard` | - |
| 2 | 거래처 관리 | `/tax/clients` | - |
| 3 | 기장 대리 | `/tax/bookkeeping` | 거래 입력, 분개장, 계정별원장 |
| 4 | 세금계산서 | `/tax/invoice` | 매출, 매입 |
| 5 | 신고 관리 | `/tax/filing` | 부가세, 법인세, 종합소득세, 4대보험, 기한 캘린더 |
| 6 | 원천세 관리 | `/tax/withholding` | - |
| 7 | 급여 관리 | `/tax/payroll` | - |
| 8 | 수임계약 관리 | `/tax/contracts` | - |
| 9 | 세무 상담 | `/tax/consultation` | - |
| 10 | 기업자문 | `/tax/advisory` | - |
| 11 | 성실신고 확인 | `/tax/honest-filing` | - |
| 12 | 리포트 | `/tax/reports` | - |
| 13 | AI 분석 | `/tax/ai` | - |
| 14 | 세무 설정 | `/tax/settings` | - |

## 3. 페이지 컴포넌트 구조

**`src/erp/pages/TaxAccountant/`** 디렉토리:

```
TaxAccountant/
├── index.ts              # 메인 export (lazy loading용)
├── Dashboard/            # 대시보드, 통계 카드
├── Clients/              # 거래처 관리 (폼, 테이블, 검색 모달)
├── Bookkeeping/          # 거래입력, 분개장, 계정별원장
├── Invoice/              # 세금계산서 목록, 필터, 모달
├── Filing/               # 신고 페이지 (VAT, 법인세, 소득세, 보험, 캘린더)
├── Withholding/          # 원천세 관리
├── Payroll/              # 급여 기록
├── Consultation/         # 세무 상담
├── HonestFiling/         # 성실신고 확인
├── Reports/              # 세무 리포트
├── AI/                   # AI 분석
├── Settings/             # 세무 설정
├── Contract/             # 수임계약 관리
└── common/               # 공통 (TaxClientDropdown)
```

## 4. API 타입 정의

**`src/erp/api/taxAccountant/taxAccountant.types.ts`** (471줄)

주요 인터페이스:
- `TaxContract` — 수임계약 (거래처, 서비스유형, 금액, 기간)
- `TaxInvoice` — 세금계산서 (매출/매입)
- `TaxFiling` — 세금 신고 기록
- `WithholdingRecord` — 원천세 기록
- `PayrollRecord` — 급여 기록
- `HonestFilingTarget` — 성실신고 대상
- `TaxDashboardData` — 대시보드 통계

서비스 타입 enum: BOOKKEEPING, VAT, CORPORATE_TAX, INCOME_TAX, WITHHOLDING, PAYROLL

## 5. 모듈 매핑

**`src/erp/layout/menu/menuModuleMap.ts`** (228-269줄)

| 모듈 ID | 포함 메뉴 |
|---------|----------|
| `tax-erp` | 전체 22개 메뉴 항목 |
| `tax-invoice` | 세금계산서만 |
| `tax-vat` | 부가세 신고만 |
| `tax-filing` | 신고 관련 전체 |
| `tax-payroll` | 급여만 |
| `tax-withholding` | 원천세만 |
| `tax-consulting` | 상담만 |
| `tax-bookkeeping` | 기장대리+하위 |

## 6. 접근 제어 흐름

1. `MenuFactoryV2.createMenuStructure()` → 사용자 role 정규화
2. `dtype === 'semusa'` 확인 → 세무사 메뉴 카테고리 포함
3. 각 페이지: `AdminUserIdGate` 컴포넌트로 이중 검증
   - `allowProfessionalType={UserModel.UserType.SEMUSA}` 또는
   - `allowedUserIds={ADMIN_USER_IDS}`

## 7. 다국어

`src/i18n/locales/ko/sidebar.json`에 모든 메뉴 라벨 한국어 정의 포함.

## 8. 라우트

`ErpApp.tsx`에 세무사 전용 라우트:
- `pro/tax-accountant/updating` — 개발중 플레이스홀더
- `pro/tax/consultation` — 전문가 상담 목록
- `pro/tax/advisory` — 기업자문 요청
