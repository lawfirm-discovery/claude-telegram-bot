# 회계사 메뉴 검증 라운드 6-15 — 개선 항목 및 결과

## 라운드 8 (2026-05-08) — API 정합성 검증 + 누락 엔드포인트 구현

### 검증 범위
- Frontend: 13개 회계사 페이지 전체 코드 리뷰
- Backend: 7개 컨트롤러 엔드포인트 매핑 검증
- TypeScript: 전체 프로젝트 `tsc --noEmit` 에러 체크

### TypeScript 검증 결과
- **에러: 0건** (전체 프로젝트 기준)

### API 엔드포인트 매핑 검증 (Frontend ↔ Spring)

| 모듈 | 엔드포인트 | 프론트 | 백엔드 | 상태 |
|------|-----------|--------|--------|------|
| 사건관리 | /api/erp/accountant/cases (CRUD) | O | O | PASS |
| 감사계획 | /api/erp/accountant/audit-plans (CRUD) | O | O | PASS |
| 감사보고서 | /api/erp/accountant/audit-reports (CRUD) | O | O | PASS |
| 감사조서 | /api/erp/accountant/cases/{id}/workpapers | O | O | PASS |
| 조서 CRUD | /api/erp/accountant/workpapers/* | O | O | PASS |
| 증빙 | /api/erp/accountant/workpapers/{id}/evidences | O | O | PASS |
| 검토의견 | /api/erp/accountant/workpapers/{id}/comments | O | O | PASS |
| 타임시트 | /api/erp/accountant/timesheet (CRUD) | O | O | PASS |
| 결산진행 | /api/erp/accountant/closing-progress | O | O | PASS |
| 재무제표 | /api/erp/accountant/financial-statements | O | O | PASS |
| 세무조정 | /api/erp/accountant/tax-adjustments | O | O | PASS |
| **내부통제** | /api/erp/accountant/internal-controls (CRUD) | O | **X→O** | **FIX** |
| **AI분석** | /api/erp/accountant/ai-analysis | O | **X→O** | **FIX** |

### 발견된 이슈 및 수정

#### ISSUE-R8-01: 내부통제(InternalControlPage) 백엔드 미구현 [FIXED]
- **심각도**: HIGH — CRUD 4개 API 호출이 모두 404 반환
- **영향**: 내부통제 평가 페이지에서 데이터 저장 불가
- **수정**: Entity, DTO, Repository, Service, Controller, SQL 마이그레이션 전체 생성
  - `ErpAccountantInternalControl.java` (Entity)
  - `ErpAccountantInternalControlRepository.java`
  - `ErpAccountantInternalControlDTO.java`
  - `ErpAccountantInternalControlRequest.java`
  - `ErpAccountantInternalControlService.java`
  - `ErpAccountantInternalControlController.java`
  - `V20260509_05__create_accountant_internal_control.sql`

#### ISSUE-R8-02: AI 분석 엔드포인트 미구현 [FIXED-STUB]
- **심각도**: MEDIUM — 프론트엔드가 SAMPLE_SUGGESTIONS로 graceful fallback
- **수정**: WorkpaperController에 스텁 GET `/ai-analysis` 추가 (빈 배열 반환)
- **후속**: FastAPI 연동 시 실제 AI 분석 로직 구현 필요

### 코드 품질 확인 (이슈 없음)
- Dashboard: MOCK_STATS는 초기값/폴백용, 실제 API 4종 병렬 호출 확인
- Timesheet: CRUD + optimistic update + 필터링 정상 구현
- ClosingManagement: 연도 변경 시 MOCK_CHECKLIST 리셋 후 API 로드 정상 동작
- FinancialStatements: 하드코딩 재무 데이터는 템플릿 용도 (API 저장/로드도 구현됨)
- TaxAdjustment: 빈 초기 상태 + CRUD 정상 구현
- AuditExecution: 조서 CRUD + 증빙 업로드 + 검토의견 + PDF 내보내기 완비
- AuditReport: 감사보고서 CRUD + 전자서명(SignatureMaker) + PDF 내보내기
- AccountingDocs: LDriveV3 연동 + FileViewerRouter 파일 미리보기
- 모든 모달: backdrop blur + createPortal + z-index 1300 적용

### 메뉴 라우팅 검증
- AccountantMenuItems.tsx: 22개 메뉴 항목 정의
- 모든 path가 실제 페이지 컴포넌트와 매핑됨
- lazyWithRetry 사용하여 코드 스플리팅 적용

### 남은 작업 (라운드 9+)
- [ ] AI 분석 실제 로직 구현 (FastAPI 연동)
- [ ] 재무제표 페이지 실제 데이터 연동 (현재 하드코딩 샘플)
- [ ] 대시보드 recentActivities 구현 (현재 빈 배열)
- [ ] 감사보고서 draftReports/issuedReports 카운트 대시보드 반영
