# 웹-Flutter 동기화 갭 분류 보고서

> 작성일: 2026-05-08
> 분석 대상: lemon-front (React), lemon_flutter (Flutter), lemon-api-server-spring (Spring Boot)
> 브랜치: dev-hs-rtx6000-new

---

## 요약

| 분류 | 건수 | 설명 |
|------|------|------|
| **웹만 존재** | 12건 | 웹에만 구현, Flutter 미구현 |
| **Flutter만 존재** | 4건 | Flutter에만 구현, 웹 미구현 |
| **구현 방식 다름** | 14건 | 양쪽 모두 존재하나 범위/깊이/UI 방식 상이 |
| **동기화 완료** | 8건 | 양쪽 기능적으로 동등 |
| **합계** | 38건 | |

---

## 1. 웹만 존재 (WEB_ONLY) — 12건

### WO-1. 레몬스토어 (E-Commerce) [HIGH]
- **웹**: 완전한 e-커머스 — 상품 카탈로그, 장바구니, 결제, 판매자 대시보드, 분석, 정산
- **Flutter**: 메뉴 항목만 존재 (organization_menu_items, admin_menu_items에 라우트 등록), 전용 페이지 없음
- **Spring API**: `/api/store/products`, `/api/store/orders`, `/api/store/reviews`, `/api/expert/settlement-account` (35+ 엔드포인트)
- **영향도**: HIGH — 전문가 수익 모델의 핵심 채널
- **웹 파일**: `src/erp/pages/LemonStore/` (StoreHomePage, StoreProductPage, StoreCheckoutPage, LemonStoreProfessionalDashboard, LemonStoreAnalytics, LemonStoreSettlements)

### WO-2. 클라우드 통합 (Google Drive/OneDrive/Dropbox) [HIGH]
- **웹**: MCP 커넥터 + OAuth + CloudFilesPage로 외부 스토리지 파일 직접 탐색/첨부
- **Flutter**: MCP 엔티티 파서(mcp_entity_parsers.dart)만 존재, 실제 클라우드 파일 브라우저 UI 없음
- **Spring API**: `/api/mcp/*`, OAuth 콜백 엔드포인트
- **영향도**: HIGH — LDrive와 연동되는 핵심 생산성 기능

### WO-3. 조직 DLP (Data Loss Prevention) [MEDIUM]
- **웹**: DLP 설정, 감사 로그, 통계 페이지
- **Flutter**: 관련 코드 없음
- **Spring API**: `/api/organization/{orgId}/dlp/settings`, `/dlp/logs`, `/dlp/stats`
- **영향도**: MEDIUM — 기업 보안/컴플라이언스 기능

### WO-4. 조직 API 키 관리 [MEDIUM]
- **웹**: API 키 생성/삭제/목록 페이지
- **Flutter**: organization 디렉토리에 API 키 관련 코드 없음
- **Spring API**: `/api/organization/{orgId}/api-keys` CRUD
- **영향도**: MEDIUM — 개발자/기업 통합용

### WO-5. 웹훅/텔레그램 설정 [MEDIUM]
- **웹**: 웹훅 URL 설정, 텔레그램 봇 연동 설정 페이지
- **Flutter**: 관련 코드 없음
- **Spring API**: `/api/erp/webhook-settings`, `/api/erp/telegram-settings`
- **영향도**: MEDIUM — 알림 자동화

### WO-6. 전문가 블로그 [LOW]
- **웹**: ExpertBlogListPage — 전문가 콘텐츠/블로그 게시 및 조회
- **Flutter**: 메뉴 항목만 존재 (organization_menu_items에 라우트), 전용 페이지 없음
- **Spring API**: `/api/expert/*` 블로그 관련 엔드포인트
- **영향도**: LOW — 마케팅/콘텐츠 채널

### WO-7. 프로모션 관리 (관리자) [LOW]
- **웹**: PromotionManagementPage — 프로모션 분석/관리 대시보드
- **Flutter**: settings에 promotion_tab_widget.dart 존재하나 관리 기능 아닌 표시만
- **영향도**: LOW — 관리자 전용

### WO-8. 조직 회계 고급 기능 [HIGH]
- **웹**: 경비(Expense) CRUD + 승인, 예산(Budget) 관리, 기간 마감(Closing), 재무보고서
- **Flutter**: org_financial_tabs.dart로 기본 조회만 가능, CRUD/승인 워크플로우 없음
- **Spring API**: `/api/organization/{orgId}/accounting/*` (100+ 엔드포인트)
- **영향도**: HIGH — 조직 재무관리 핵심

### WO-9. 계약 AI 분석 (기업용) [MEDIUM]
- **웹**: ContractAIPage — AI 기반 계약서 분석 (리스크 식별, 조항 비교)
- **Flutter**: 없음
- **Spring API**: 관련 AI 엔드포인트
- **영향도**: MEDIUM — 기업 사용자 핵심 기능

### WO-10. 문서 협업 (실시간 공동 편집) [MEDIUM]
- **웹**: 문서 코멘트, 협업자 초대, 역할 관리, 버전 비교
- **Flutter**: 문서 공유(share)만 지원, 실시간 협업 없음
- **Spring API**: `/api/document-collaboration/*`, `/api/documents/{id}/comments`
- **영향도**: MEDIUM — 팀 생산성

### WO-11. 통합 파일 동기화 (Unified Files) [LOW]
- **웹**: LDrive unified-files 탭으로 클라우드 스토리지 통합 뷰
- **Flutter**: 없음 (WO-2 클라우드 통합의 하위 기능)
- **영향도**: LOW — WO-2에 종속

### WO-12. 관리자 DB 관리 / 시스템 모니터링 [LOW]
- **웹**: DbManagement, FeatureMapPage, 스케줄러 관리
- **Flutter**: 없음 (관리자 전용)
- **영향도**: LOW — 관리자/개발자 전용

---

## 2. Flutter만 존재 (FLUTTER_ONLY) — 4건

### FO-1. 네이티브 결제 (모바일 전용) [PLATFORM]
- **Flutter**: native_payment_page.dart — 앱스토어/구글플레이 인앱결제
- **웹**: 웹 결제 (PG사 연동)만 존재, 네이티브 결제 불필요
- **분류**: 플랫폼 고유 기능 (동기화 불필요)

### FO-2. 네이티브 문서 에디터 [PLATFORM]
- **Flutter**: native_editor_page.dart — 모바일 최적화 문서 편집기
- **웹**: LemonEditorV7 (브라우저 기반)
- **분류**: 플랫폼 고유 구현 (동기화 불필요, 기능적으로 동등해야 함)

### FO-3. 비디오 콜 오버레이 [PLATFORM]
- **Flutter**: video_call_overlay.dart, call_gateway.dart — 앱 내 비디오콜 오버레이/PIP
- **웹**: 비디오 회의 페이지만 존재 (오버레이/PIP 미지원)
- **분류**: 플랫폼 고유 UX (모바일 특화)

### FO-4. 조직 채팅 전용 모듈 [LOW]
- **Flutter**: features/organization_chat/ — 조직 전용 채팅 룸/페이지
- **웹**: 일반 채팅에 조직 필터로 통합
- **영향도**: LOW — 구현 방식 차이에 가까움

---

## 3. 구현 방식 다름 (DIFFERENT_IMPL) — 14건

### DI-1. 레몬 가디언 (AI 수사 도구) [HIGH]
- **웹**: 통합 AI 수사실(AiInvestigationRoomPage) — 단일 인터페이스에서 모든 수사 도구 접근
- **Flutter**: 개별 페이지로 분리 (malicious_comment_crawler, news_auto_collector, digital_forensic, web_evidence_capture, traffic_accident, asset_tracker, crypto_tracker, evidence_tamper)
- **차이점**: 웹은 통합형 UI, Flutter는 도구별 분리형 UI
- **동기화 방향**: Flutter에 통합 수사실 뷰 추가 또는 웹에 개별 도구 바로가기 추가 권장

### DI-2. 전문가 모듈 (11종) [HIGH]
- **웹**: 전문가별 전용 라우트 + 상세 페이지 (특허: 6개 서브페이지, 회계사: 8개 서브페이지 등)
- **Flutter**: 전문가별 메인 페이지 1개 + 위젯 탭 방식 (patent_main_page, accountant_main_page 등)
- **차이점**: 웹이 훨씬 깊은 기능 (특허 포트폴리오, 회계 원장/세무신고/감사 워크플로우 등), Flutter는 기본 대시보드 수준
- **주요 갭**:
  - 특허: Filing/Portfolio/Deadline/Trial/Client/Billing 서브페이지 → Flutter는 검색+대시보드만
  - 회계: 복식부기/세무신고/감사 워크플로우 → Flutter는 기본 탭
  - 세무: 세무 자문 전용 페이지 → Flutter 기본 대시보드
  - 관세/감정평가/행정사: 웹 상세 워크플로우 → Flutter 기본 페이지

### DI-3. 대시보드 [MEDIUM]
- **웹**: RoleBasedDashboard — 사용자 역할별 동적 대시보드 + KPI + 통계
- **Flutter**: lflow_dashboard_page.dart + 전문가별 대시보드 위젯 (분산)
- **차이점**: 웹은 중앙 집중 역할기반, Flutter는 모듈별 분산

### DI-4. 조직 HR (출퇴근/휴가/급여) [MEDIUM]
- **웹**: OrganizationManagementPage에 통합 (멤버 + 설정 중심)
- **Flutter**: 별도 페이지 (hr_attendance_page, hr_leave_page, hr_payroll_page)
- **차이점**: Flutter가 HR 기능을 더 세분화된 전용 페이지로 구현. 웹은 조직 설정에 통합
- **동기화 방향**: 웹에 HR 전용 서브페이지 추가 권장

### DI-5. 사건관리 UI 구조 [MEDIUM]
- **웹**: CaseMainPage + CaseRegistrationPage + CaseProgressPage + DelegatedCaseMainPage
- **Flutter**: case_main_page + case_registration_page + case_history_page + LFlow case_detail_page
- **차이점**: 대체로 동등하나, 웹은 위임소송 전용 페이지, Flutter는 LFlow 통합 뷰 중심
- **동기화 방향**: 기능적으로 유사, UI 패턴 통일 권장

### DI-6. 상담 & 전문가 채팅 [MEDIUM]
- **웹**: 상담 + 자문(Advisory) 분리, 전문가 매칭 마켓플레이스
- **Flutter**: 상담 + 전문가 채팅 통합, ADR(중재/조정) 포함
- **차이점**: 웹에 Advisory 전용 워크플로우, Flutter에 ADR 전용 페이지
- **누락**: 웹 Advisory → Flutter 미구현 / Flutter ADR → 웹은 Discovery&ADR에 통합

### DI-7. 문서 관리 & LDrive [MEDIUM]
- **웹**: LDriveV3 + unified-files + 문서 공유 보드 + 접근 이력(audit)
- **Flutter**: ldrive_main_page + 문서 공유 + 파일 리스트
- **차이점**: 웹이 접근 이력, 통합 파일 뷰, OCR 분석 등 고급 기능 보유
- **누락**: 문서 접근 이력, OCR 분석 UI

### DI-8. 계약 & 전자서명 [LOW]
- **웹**: 개인 계약 + Lemon Contract 스위트 + 기업 계약 AI + 템플릿 + 빌링
- **Flutter**: 계약 대시보드 + 상세 + 서명 + 템플릿 편집 + 공개 서명 브릿지
- **차이점**: 대체로 동등. 웹에 ContractAI(WO-9) 추가, 빌링 상세 뷰 더 풍부
- **동기화 방향**: 핵심 워크플로우 동등, AI 분석만 갭

### DI-9. 일정/캘린더 [LOW]
- **웹**: SchedulePage + Google/Outlook/Notion 캘린더 동기화
- **Flutter**: schedule_main_page + lflow_schedule_page
- **차이점**: 웹에 외부 캘린더 연동 있음, Flutter는 자체 캘린더만
- **누락**: Flutter 외부 캘린더 동기화

### DI-10. 커뮤니티 & 학습 [LOW]
- **웹**: CommunityHome + LawschoolCommunityList (풀 포럼)
- **Flutter**: lawschool_community_page.dart (기본 리스트만)
- **차이점**: 웹은 완전한 포럼 (작성/댓글/검색), Flutter는 조회 위주

### DI-11. 속기사 모듈 [LOW]
- **웹**: CourtReporterTrackingPage — 배정 + 추적
- **Flutter**: court_reporter_fee_page, court_reporter_schedule_page, court_reporter_work_list_page
- **차이점**: Flutter가 더 세분화 (비용/일정/작업 리스트), 웹은 통합 추적 뷰

### DI-12. 메모 & 노트 [LOW]
- **웹**: 사건 메모 + 통합 메모 (unified memo API)
- **Flutter**: personal_memo_page + 사건별 메모
- **차이점**: 기능 동등, UI 레이아웃 차이

### DI-13. 지식 그래프 [LOW]
- **웹**: Knowledge Graph 생성/검색 페이지
- **Flutter**: knowledge_graph_page.dart 존재
- **차이점**: 양쪽 기본 구현 존재, 깊이 비교 필요

### DI-14. 타임라인 메이커 [LOW]
- **웹**: 관련 페이지 미확인 (AI 타임라인 분석 API만 존재)
- **Flutter**: timeline_maker_page.dart + tools_page에서 접근
- **차이점**: Flutter에 전용 도구 페이지, 웹은 AI API 연동만

---

## 4. 동기화 완료 (SYNCED) — 8건

| # | 기능 | 설명 |
|---|------|------|
| S-1 | 인증 & 로그인 | 이메일/소셜(카카오/구글) 로그인, 회원가입, 비밀번호 재설정 |
| S-2 | 사용자 프로필 | 프로필 편집, 전문가 전환, 자격증 관리 |
| S-3 | 법령/판례 검색 | 법령 DB 검색, 판례 검색, 법률 뉴스 |
| S-4 | 전자계약 기본 | 계약 생성/발송/서명 기본 워크플로우 |
| S-5 | 결제 & 포인트 | 결제 처리, 포인트 조회/사용 |
| S-6 | 알림 & 메시지 | 내부 메시지, 알림 센터 |
| S-7 | AI 채팅 | AI 채팅 인터페이스, 문서 생성 |
| S-8 | 비디오 회의 | LiveKit 기반 화상 회의 |

---

## 5. 우선순위 매트릭스

### P0 — 즉시 동기화 필요 (비즈니스 임팩트 HIGH)
| ID | 기능 | 방향 | 예상 규모 |
|----|------|------|----------|
| WO-1 | 레몬스토어 | → Flutter | XL (신규 모듈) |
| WO-8 | 조직 회계 고급 | → Flutter | L (CRUD+워크플로우) |
| DI-2 | 전문가 모듈 깊이 | → Flutter | XL (11종 × 서브페이지) |
| WO-2 | 클라우드 통합 | → Flutter | L (OAuth+파일브라우저) |

### P1 — 다음 스프린트 (기능 완성도)
| ID | 기능 | 방향 | 예상 규모 |
|----|------|------|----------|
| DI-1 | 가디언 통합 뷰 | Flutter 개선 | M |
| WO-9 | 계약 AI 분석 | → Flutter | M |
| WO-10 | 문서 협업 | → Flutter | M |
| DI-4 | 조직 HR 세분화 | → 웹 | M |
| WO-3 | 조직 DLP | → Flutter | S |

### P2 — 점진적 개선 (편의 기능)
| ID | 기능 | 방향 | 예상 규모 |
|----|------|------|----------|
| DI-6 | 상담 Advisory/ADR | 양방향 | M |
| DI-7 | LDrive 고급 | → Flutter | S |
| DI-9 | 캘린더 연동 | → Flutter | S |
| WO-4 | API 키 관리 | → Flutter | S |
| WO-5 | 웹훅/텔레그램 설정 | → Flutter | S |
| DI-3 | 대시보드 통합 | 양방향 | M |

### P3 — 낮은 우선순위
| ID | 기능 | 방향 | 예상 규모 |
|----|------|------|----------|
| DI-10 | 커뮤니티 포럼 | → Flutter | S |
| WO-6 | 전문가 블로그 | → Flutter | S |
| DI-11 | 속기사 모듈 | 양방향 | S |
| WO-7 | 프로모션 관리 | → Flutter | S |
| WO-12 | 관리자 도구 | 동기화 불필요 | - |

---

## 6. API 커버리지 분석

### Spring API 총 ~1,300 엔드포인트

| 영역 | Spring 엔드포인트 | 웹 호출 | Flutter 호출 | 갭 |
|------|-------------------|---------|-------------|-----|
| 조직/회계 | 210+ | ~180 | ~60 | Flutter ▼▼ |
| 관리자/행정 서비스 | 130+ | ~120 | ~40 | Flutter ▼▼ |
| Class Action | 60+ | ~55 | ~45 | Flutter ▼ |
| AI 서비스 | 85+ | ~70 | ~50 | Flutter ▼ |
| 사건관리 | 44 | ~40 | ~35 | 유사 |
| 계약 | 35 | ~32 | ~28 | 유사 |
| 상담 | 25 | ~23 | ~20 | 유사 |
| 채팅/메시지 | 32 | ~28 | ~25 | 유사 |
| 문서 | 40+ | ~38 | ~30 | Flutter ▼ |
| 인증/사용자 | 94 | ~85 | ~70 | 유사 |
| 가디언/증거 | 75+ | ~65 | ~55 | 유사 |
| 결제 | 25+ | ~20 | ~18 | 유사 |

**총 API 커버리지 추정**:
- 웹: ~75% (약 975/1300 호출)
- Flutter: ~45% (약 585/1300 호출)
- **갭: ~390 엔드포인트** (주로 조직 회계, 관리자 서비스, 전문가 상세 기능)

---

## 7. 다음 단계 권장사항

1. **P0 항목 상세 설계**: 레몬스토어, 조직 회계, 전문가 모듈 Flutter 구현 계획 수립
2. **API 호출 매핑 상세화**: Flutter에서 미호출 ~390개 엔드포인트의 필요/불필요 분류
3. **공통 컴포넌트 식별**: Flutter 신규 구현 시 재사용 가능한 웹 컴포넌트 패턴 추출
4. **스프린트 계획**: P0 4건 → P1 5건 → P2 6건 순서로 분기별 로드맵 수립
