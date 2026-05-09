# 웹-Flutter 동기화 개선 계획

> 작성일: 2026-05-09
> 기반 문서: web-flutter-sync-gap-classification.md (38건 갭 분류)
> 브랜치: dev-hs-rtx6000-new

---

## 실행 요약

| Phase | 기간 | 갭 수 | 핵심 목표 |
|-------|------|-------|----------|
| Phase 1 | 4주 | 4건 (P0) | 비즈니스 임팩트 HIGH 항목 Flutter 구현 |
| Phase 2 | 3주 | 5건 (P1) | 기능 완성도 향상 |
| Phase 3 | 4주 | 6건 (P2) | 편의 기능 동기화 |
| Phase 4 | 필요시 | 4건 (P3) | 낮은 우선순위 점진 개선 |

---

## Phase 1 — P0: 즉시 동기화 (4주)

### WO-1. 레몬스토어 → Flutter 구현
- **규모**: XL (2주)
- **변경 파일 (Flutter)**:
  - `lib/features/lemon_store/` — 신규 모듈 생성
    - `store_home_page.dart` — 상품 카탈로그 + 카테고리 브라우저
    - `store_product_detail_page.dart` — 상품 상세 + 리뷰
    - `store_checkout_page.dart` — 장바구니 + 결제
    - `store_seller_dashboard_page.dart` — 판매자 대시보드 (전문가 전용)
    - `store_analytics_page.dart` — 매출/트래픽 분석
    - `store_settlement_page.dart` — 정산 내역
  - `lib/features/lemon_store/widgets/` — 공통 위젯
    - `product_card_widget.dart`, `cart_bottom_sheet.dart`, `review_list_widget.dart`
  - `lib/features/lemon_store/providers/` — 상태관리
    - `store_provider.dart`, `cart_provider.dart`, `settlement_provider.dart`
  - `lib/core/api/` — API 클라이언트 추가
    - 기존 `api_service.dart`에 store 엔드포인트 추가 (35+ 엔드포인트)
  - `lib/core/models/` — DTO 모델
    - `store_product.dart`, `store_order.dart`, `store_review.dart`, `settlement.dart`
  - `lib/config/menu/` — 메뉴 등록
    - `organization_menu_items.dart` 기존 라우트를 실제 페이지로 연결
- **Spring API**: 변경 없음 (기존 35+ 엔드포인트 활용)
- **테스트 항목**:
  - [ ] 상품 카탈로그 로딩 (카테고리별 필터링)
  - [ ] 장바구니 추가/삭제/수량변경
  - [ ] 결제 프로세스 (PG사 연동)
  - [ ] 판매자 대시보드 통계 표시
  - [ ] 정산 내역 조회 + 기간 필터
  - [ ] 모바일 UX (스크롤, 이미지 로딩, 반응형)

### WO-8. 조직 회계 고급 기능 → Flutter 구현
- **규모**: L (1.5주)
- **변경 파일 (Flutter)**:
  - `lib/features/organization/accounting/` — 기존 디렉토리 확장
    - `expense_management_page.dart` — 경비 CRUD + 승인 워크플로우
    - `budget_management_page.dart` — 예산 설정 + 추적
    - `period_closing_page.dart` — 기간 마감 체크리스트
    - `financial_report_page.dart` — 재무보고서 (손익/대차/현금흐름)
  - `lib/features/organization/accounting/widgets/`
    - `expense_approval_card.dart`, `budget_progress_bar.dart`, `closing_checklist.dart`
  - `lib/features/organization/accounting/providers/`
    - `expense_provider.dart`, `budget_provider.dart`, `closing_provider.dart`
  - `lib/core/models/`
    - `expense.dart`, `budget.dart`, `closing_period.dart`
- **Spring API**: 변경 없음 (기존 100+ 엔드포인트 활용)
- **테스트 항목**:
  - [ ] 경비 CRUD (등록/수정/삭제)
  - [ ] 경비 승인 워크플로우 (요청→승인→완료)
  - [ ] 예산 설정 및 잔액 추적
  - [ ] 기간 마감 체크리스트 진행
  - [ ] 재무보고서 렌더링 (차트/테이블)

### DI-2. 전문가 모듈 깊이 → Flutter 강화
- **규모**: XL (2주 — 11종 중 HIGH 영향 4종 우선)
- **우선 대상**: 변호사, 회계사, 세무사, 변리사
- **변경 파일 (Flutter)**: 전문가 타입별 서브페이지 추가
  - `lib/features/expert/lawyer/` — 기존 main_page 외 추가
    - `case_detail_page.dart` — 사건 상세 (소송기록/증거/기일)
    - `billing_page.dart` — 타임시트 + 청구서
    - `advisory_page.dart` — 기업자문 워크플로우
  - `lib/features/expert/accountant/` — 기존 main_page 외 추가
    - `audit_execution_page.dart` — 감사 조서/증빙/검토
    - `financial_statement_page.dart` — 재무제표 편집
    - `tax_adjustment_page.dart` — 세무조정
  - `lib/features/expert/tax_accountant/`
    - `tax_consultation_detail_page.dart` — 세무상담 상세
    - `tax_document_page.dart` — 세무 문서 작성
  - `lib/features/expert/patent_attorney/`
    - `patent_filing_page.dart` — 출원 관리
    - `patent_portfolio_page.dart` — IP 포트폴리오
    - `patent_deadline_page.dart` — 기한/OA 관리
  - 각 전문가 `menu_items.dart` 라우트 업데이트
- **Spring API**: 변경 없음
- **테스트 항목**:
  - [ ] 각 전문가 타입별 서브페이지 네비게이션
  - [ ] 사건 상세 CRUD (변호사)
  - [ ] 감사 워크플로우 (회계사: 조서→증빙→검토)
  - [ ] 출원 관리 (변리사: 기한 표시/알림)
  - [ ] 타임시트 입력 + 청구서 생성
  - [ ] 나머지 7종(법무사/관세사/감정평가사/행정사/노무사/공증인/속기사)는 Phase 3에서 처리

### WO-2. 클라우드 통합 → Flutter 구현
- **규모**: L (1주)
- **변경 파일 (Flutter)**:
  - `lib/features/cloud_integration/`
    - `cloud_files_page.dart` — Google Drive/OneDrive/Dropbox 브라우저
    - `cloud_auth_page.dart` — OAuth 인증 플로우
    - `cloud_file_picker.dart` — 파일 선택 + LDrive 임포트
  - `lib/features/cloud_integration/providers/`
    - `cloud_provider.dart` — OAuth 토큰/파일 목록 관리
  - `lib/core/models/`
    - `cloud_file.dart`, `cloud_connection.dart`
  - `lib/features/ldrive/` — 기존 LDrive에 클라우드 탭 추가
- **Spring API**: 변경 없음 (MCP 엔드포인트 활용)
- **테스트 항목**:
  - [ ] OAuth 인증 플로우 (Google/OneDrive/Dropbox)
  - [ ] 클라우드 파일 목록 로딩
  - [ ] 파일 선택 + LDrive 가져오기
  - [ ] 인증 만료 시 재인증 플로우

---

## Phase 2 — P1: 기능 완성도 (3주)

### DI-1. 가디언 통합 뷰 → Flutter 개선
- **규모**: M (3일)
- **변경 파일**:
  - `lib/features/guardian/` — 기존 개별 도구 페이지 유지 + 통합 뷰 추가
    - `ai_investigation_room_page.dart` — 웹의 통합 수사실 UI 미러링
    - `investigation_tool_card.dart` — 도구별 바로가기 카드
  - 기존 `malicious_comment_crawler`, `digital_forensic` 등은 유지 (통합 뷰에서 네비게이션)
- **테스트**: 통합 뷰에서 각 도구 페이지 네비게이션, 도구별 데이터 요약 표시

### WO-9. 계약 AI 분석 → Flutter 구현
- **규모**: M (3일)
- **변경 파일**:
  - `lib/features/contract/`
    - `contract_ai_analysis_page.dart` — AI 리스크 분석/조항 비교
    - `contract_ai_provider.dart`
- **테스트**: AI 분석 요청/응답, 리스크 하이라이트 표시, 조항 비교 UI

### WO-10. 문서 협업 → Flutter 구현
- **규모**: M (4일)
- **변경 파일**:
  - `lib/features/document/collaboration/`
    - `document_comments_widget.dart` — 코멘트/스레드
    - `collaborator_invite_page.dart` — 협업자 초대 + 역할
    - `version_compare_page.dart` — 문서 버전 비교
- **테스트**: 코멘트 CRUD, 협업자 초대/역할 변경, 버전 비교 표시

### DI-4. 조직 HR 세분화 → 웹 개선
- **규모**: M (3일)
- **변경 파일 (웹)**:
  - `src/erp/pages/Organization/HR/` — 신규 서브페이지
    - `HRAttendancePage.tsx` — 출퇴근 관리 (Flutter hr_attendance_page 미러링)
    - `HRLeavePage.tsx` — 휴가 관리
    - `HRPayrollPage.tsx` — 급여 관리
  - `src/erp/components/Sidebar/OrganizationMenuItems.tsx` — HR 서브메뉴 추가
- **Spring API**: 기존 HR 엔드포인트 활용
- **테스트**: 출퇴근 기록 조회/등록, 휴가 신청/승인, 급여 명세서 조회

### WO-3. 조직 DLP → Flutter 구현
- **규모**: S (2일)
- **변경 파일**:
  - `lib/features/organization/dlp/`
    - `dlp_settings_page.dart` — DLP 정책 설정
    - `dlp_audit_log_page.dart` — 감사 로그 조회
  - `lib/core/models/dlp_setting.dart`, `dlp_log.dart`
- **테스트**: DLP 설정 CRUD, 감사 로그 필터링/검색

---

## Phase 3 — P2: 편의 기능 동기화 (4주)

### DI-6. 상담 Advisory/ADR 양방향 동기화
- **규모**: M (4일)
- **웹 변경**: Advisory 워크플로우는 이미 존재. ADR 전용 페이지 추가 또는 기존 Discovery&ADR에 연결
- **Flutter 변경**: Advisory 전용 워크플로우 페이지 추가
- **테스트**: Advisory 자문 요청→수락→완료 워크플로우, ADR 중재/조정 프로세스

### DI-7. LDrive 고급 기능 → Flutter
- **규모**: S (2일)
- **변경**: 접근 이력(audit) 탭, OCR 분석 결과 표시
- **테스트**: 파일별 접근 이력 조회, OCR 텍스트 표시

### DI-9. 캘린더 외부 연동 → Flutter
- **규모**: S (2일)
- **변경**: Google/Outlook 캘린더 OAuth 연동 + 이벤트 동기화
- **테스트**: 외부 캘린더 연결/해제, 이벤트 양방향 동기화

### WO-4. API 키 관리 → Flutter
- **규모**: S (1일)
- **변경**: `lib/features/organization/api_keys/api_key_management_page.dart`
- **테스트**: API 키 생성/삭제/목록 조회

### WO-5. 웹훅/텔레그램 설정 → Flutter
- **규모**: S (1일)
- **변경**: `lib/features/organization/settings/webhook_settings_page.dart`, `telegram_settings_page.dart`
- **테스트**: 웹훅 URL 설정/테스트, 텔레그램 봇 연동

### DI-3. 대시보드 통합 → 양방향
- **규모**: M (3일)
- **웹**: 역할기반 대시보드에 Flutter 전문가 위젯 패턴 반영
- **Flutter**: 중앙 집중 역할기반 대시보드 구현 (웹 RoleBasedDashboard 미러링)
- **테스트**: 각 역할별 대시보드 KPI/통계 표시 확인

---

## Phase 4 — P3: 낮은 우선순위 (필요시)

| ID | 기능 | 규모 | 작업 내용 |
|----|------|------|----------|
| DI-10 | 커뮤니티 포럼 | S (2일) | Flutter에 게시글 작성/댓글/검색 기능 추가 |
| WO-6 | 전문가 블로그 | S (2일) | Flutter에 블로그 CRUD 페이지 추가 |
| DI-11 | 속기사 모듈 | S (1일) | 웹에 비용/일정/작업 세분화, Flutter에 통합 추적 뷰 |
| WO-7 | 프로모션 관리 | S (1일) | Flutter 관리자용 프로모션 관리 페이지 |

**동기화 불필요 항목** (Phase 대상 아님):
- WO-11: 통합 파일 동기화 (WO-2에 종속, WO-2 완료 후 자동 해소)
- WO-12: 관리자 DB 관리 (관리자 전용, 웹에서만 사용)
- FO-1~3: 플랫폼 고유 기능 (네이티브 결제, 문서 에디터, 비디오콜 오버레이)
- FO-4: 조직 채팅 (구현 방식 차이일 뿐 기능 동등)

---

## 작업량 추정 요약

| Phase | 갭 수 | 총 작업량 | Flutter 변경 | 웹 변경 | API 변경 |
|-------|-------|----------|-------------|---------|---------|
| Phase 1 | 4건 | ~6.5주 (1인) | ~45 파일 신규 | 0 | 0 |
| Phase 2 | 5건 | ~3주 (1인) | ~12 파일 신규 | ~5 파일 신규 | 0 |
| Phase 3 | 6건 | ~2주 (1인) | ~10 파일 신규/수정 | ~3 파일 수정 | 0 |
| Phase 4 | 4건 | ~1주 (1인) | ~6 파일 신규 | ~2 파일 수정 | 0 |
| **합계** | **19건** | **~12.5주** | **~73 파일** | **~10 파일** | **0** |

- Spring API 변경 없음: 대부분의 갭은 프론트엔드(Flutter/웹) 레벨이며, 백엔드 API는 이미 존재
- 나머지 19건(SYNCED 8 + FLUTTER_ONLY 4 + 동기화 불필요 7)은 작업 불필요

---

## 리스크 및 고려사항

1. **DI-2 전문가 모듈**: 11종 전체를 한 번에 하지 말고, Phase 1에서 TOP 4(변호사/회계사/세무사/변리사) 우선 → Phase 3에서 나머지 7종 보강
2. **클라우드 OAuth (WO-2)**: Flutter에서 OAuth 리다이렉트 처리는 `flutter_web_auth` 또는 `url_launcher` + deep link 필요. 플랫폼별 설정 필요 (iOS info.plist, Android intent filter)
3. **레몬스토어 결제 (WO-1)**: 모바일에서는 PG사 웹뷰 + 인앱결제 병행 필요. 앱스토어 정책 확인 필수
4. **문서 협업 실시간 (WO-10)**: WebSocket/SSE 기반 실시간 동기화는 Flutter 웹소켓 클라이언트로 구현 가능하나 복잡도 높음
5. **공통 디자인 시스템**: Flutter와 웹 간 UI 패턴 일관성을 위해 공통 디자인 토큰(색상/타이포/간격) 정의 선행 권장

---

## 실행 전 체크리스트

- [ ] Phase 1 시작 전: Flutter 프로젝트 구조 및 기존 패턴 분석 (provider vs riverpod vs bloc)
- [ ] Phase 1 시작 전: 공통 위젯/모델 재사용 목록 확정
- [ ] 각 Phase 시작 전: Spring API 엔드포인트 동작 확인 (Postman/curl)
- [ ] 각 기능 완료 후: 웹 ↔ Flutter 기능 동등성 크로스 테스트
- [ ] Phase 1 완료 후: API 커버리지 재측정 (목표: Flutter 45% → 65%)
