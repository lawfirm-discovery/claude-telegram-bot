# lemon-front 최근 6개월 주요 기능 보고서

**기간**: 2025-11-11 ~ 2026-05-11
**총 커밋**: 11,089개 (기능 커밋 약 300+개)
**브랜치**: dev-hs-rtx6000-new

---

## 1. V7 에디터 (LemonEditorV7) — 최대 투자 영역

### 1.1 핵심 에디터 기능
- **Cmd+K 인라인 AI 편집** + AI 생성 sticky bar (Sprint 1)
- **RAG 출처 사이드바** (SourcesPanel) + 인라인 citation chip + 판례 regex (Sprint 2)
- **Tool Approval inline** + Confidence list (Sprint 3 Week2)
- **Wizard 모드** — DB schema 100% 활용 (Sprint 3 Week3)
- **이모지 picker** — 검색/스킨톤/최근 + 350개 이모지 (외부 의존성 없음)
- **차트 삽입** — bar/line/pie, Canvas 렌더, 데이터 편집 UI
- **차트 DOCX/HWPX export** — 이미지 직렬화 + round-trip
- **Format Painter** 버튼 + Sup/Sub mutex
- **문단 간격** — Word 표준, 법률 문서 필수
- **헤더 서식 메뉴** — 제목 1~6 + 본문

### 1.2 표 편집 (Google Docs 패리티)
- 셀/행/열 단위 **배경색 + 테두리 색상**
- **면(face) 선택** UI — Google Docs 스타일
- 표 paste — Word div / Excel TSV / 셀 서식·이미지
- colspan/rowspan paste + thead headerRows + cell.textAlign
- DOCX/HWPX/HTML/PDF **셀 가로정렬·병합·헤더반복** export
- 표 셀 ↑↓ 정식 통합

### 1.3 각주/미주 시스템 (Phase CC~CV, 20+ 커밋)
- 각주 삽입 UI (툴바 버튼)
- 페이지 하단 렌더링
- 다단락 스키마 (표·이미지·텍스트 subParagraphs)
- DOCX/HWPX import + export
- 클릭 네비게이션 (ref↔zone 양방향 스크롤)
- 위첨자 마커 + 각주→본문 reverse navigation
- 미주(endnote) 지원
- 키보드 편집 완성
- PDF export 각주/미주 렌더링

### 1.4 도장/서명 기능
- V7 캔버스 **도장 드래그&드롭 + 8방향 리사이즈**
- 도장 드래그 이동 + 텍스트 배치(wrapMode)
- 이미지와 동일한 8방향 핸들 UX
- 모바일 터치 e2e 검증

### 1.5 HWP/HWPX 통합
- **@rhwp/core 단일 인라인 스택**으로 HWP 통합 (Phase A)
- **V7 → HWP 5 바이너리 export** (Phase B)
- HWP 이미지 추출 (도장/서명)
- import 이미지를 **LDrive V3 로 영구 업로드**
- HWPX 각주 내 표·이미지 정식 객체 export

### 1.6 실시간 협업
- **y-websocket 서버 + 클라이언트 hook 통합** (G7)
- **ECS Fargate 상용 배포** — JWT/Redis/메트릭/graceful shutdown
- 변경추적/오프라인/가상화/서명무결성/PDF폰트

### 1.7 접근성 & 모바일
- Screen reader용 **HiddenTextLayer**
- 캔버스 표 **SR-only ARIA overlay**
- 모바일 **Google Docs 스타일 커서 핸들 드래그**
- 모바일 패널 토글 버튼 ToolBarV7 통합
- 모바일 셀렉션 4종 개선

### 1.8 기타 에디터
- 캔버스 이미지 drag&drop
- paste 안전성 — IME 차단 + 이미지 URL 자동 다운로드
- 이미지 선택 시 copy → image MIME 클립보드 저장
- z-index 토큰 점진적 마이그레이션
- 링크 hover cursor=pointer 피드백
- ESC 키로 채팅 '선택됨' 칩 + 본문 pin 하이라이트 해제
- 문서정보 탭 + 파일 세부정보 Google Docs 스타일

---

## 2. 전문가 타입별 ERP 상용화 (11종 중 7종 완료)

### 2.1 세무사 (SEMUSA)
- ERP 상용화 — **frontend API 연동 전체 완료**
- PDF 다운로드 버튼 연결
- 대시보드 Mock→실API
- AI 문서 생성 탭 + FastAPI /api/v7/generate 연동
- 수임계약 관리 독립 페이지
- 신고 관리 서브페이지 4개 (법인세/소득세/4대보험/기한캘린더)
- 기업자문 메뉴 추가

### 2.2 변리사 (PATENT)
- ERP Frontend **상용화 개선**
- 메뉴 4개 기능 구현
- 출원상세모달 — AI 연동·PDF내보내기·수임계약 발송
- 청구관리·의뢰인관리 상용수준 (PDF, 전자계약, 실API등록)
- 관납료+수임료 **자동계산 엔진**
- 심판관리 수정 기능

### 2.3 회계사 (ACCOUNTANT)
- ERP 페이지 **상용수준 재설계** (PDF/전자서명/LDrive 연동)
- 전용 페이지 **9종 구현** 및 라우트 연결
- 감사보고서·결산체크리스트 API 연동
- 세무조정/재무제표 저장·불러오기
- 차트·페이지네이션·카테고리 현황
- InternalControl API연동+삭제, AuditReport 수정/삭제
- AI분석 페이지, 타임시트 페이지 신규

### 2.4 행정사 (ADMINISTRATIVE)
- 전용 메뉴 활성화 (기존 공통 컴포넌트 재활용)
- **6개 미구현 메뉴 구현**
- 대시보드 실제 API 데이터 연동
- i18n 키 추가

### 2.5 노무사 (LABOR)
- ERP 메뉴 **상용 수준**으로 완성
- 전용 **계산기 3종** 추가
- 대시보드 빈 상태 초기화 CTA

### 2.6 법무사 (JUDICIAL_SCRIVENER)
- 메뉴 상용 수준 개선 (Phase 2)

### 2.7 속기사 (COURT_REPORTER)
- TranscriptStudio **세벌식 모드** 추가
- STT 변환 및 탭 전환 개선
- 대시보드 추가 및 수수료 페이지 개선
- 약 25라운드에 걸친 안정성 버그 수정

---

## 3. 기업법무 (Corporate) — Phase A~E

- **Phase A**: 결재선 워크플로우 페이지 + 계약 결재 진행 위젯 + 감사 PDF 다운로드
- **Phase B**: 정관 관리 페이지
- **Phase C**: 이사회/주총 의사록 페이지
- **Phase D**: 주주명부 / Cap Table 페이지
- **Phase E**: 지식재산권(IP) 내 의뢰 탭 추가
- 기업메뉴 더미 데이터 → **실제 API 연동**

---

## 4. i18n 다국어 지원 — 대규모 마이그레이션

- **신규 7언어** 추가: vi, id, zh-TW, es, th, fr, de
- 기존 4언어 (ko, en, ja, zh-CN) 누락 키 보충
- **HttpBackend lazy load 전환**
- navigator 기반 **기본 언어 자동 감지**
- 약 100+ 컴포넌트에 t() 마이그레이션
- 전체 11언어 지원 (LanguageSwitcher 전역 노출)
- namespace별 번역: editor, sidebar, classaction, contract, admin 등

---

## 5. 채팅 & 실시간 통신

- **채팅 히스토리 localStorage → IndexedDB 마이그레이션**
- expertChatRoomsStore 신설 — **WS 단일 source 통합** (Phase 1~2) + firebaseStore cleanup
- 채팅 사이드바 **batch endpoint** — Promise.all 14번 → 1번
- 채팅 첨부파일 표시 + 스트리밍 대기 애니메이션
- AI 채팅 버블 렌더링 + 문서-채팅방 연결
- FCM **웹 푸시 알림** 옵트인 하이브리드 구현

---

## 6. 전자계약

- **상용화 버그 수정** (4 iterations)
- 서명 완료 후 PDF 다운로드 버튼
- 즉시 발송 버그 수정
- 템플릿 필터 칩 단순화 (5종→3종)

---

## 7. LDrive (클라우드 저장소)

- **Multipart presigned upload** (100MB+ 대용량 파일)
- 포렌식 케이스 폴더 뱃지 표시 + 자동 새로고침
- 선택바 아이콘+제목 표시 + 포렌식 케이스 지정 버튼
- 문서 URL 접근 시 해당 폴더 자동 이동

---

## 8. SEO & 도메인 전환

- legalmonster.co.kr → **legalmonster.ai** URL 전면 교체
- JSON-LD 구조화 데이터 추가
- robots.txt 정리
- AI 검색 최적화 + MCP 등록 파일

---

## 9. AI & 관리자 기능

- **자체 에러 수집 + 텔레그램 알림** (Sentry 대체)
- 웹 errorReporter — viewport/locale/timezone enrich
- STT/OCR 엔진 선택 패널 + **BYOK provider 5종** 추가
- AI 모델 선택기를 UnifiedModelSelector로 통합
- API 게이트웨이 로컬 서버 목록에 VLM 서버 추가
- 이미지 생성/영상 생성 서버 대시보드
- 레몬봇 관리자 전용 제한

---

## 10. 인프라 & 성능

- ERP 동적 라우트에 **PageSkeleton Suspense** 래핑
- 번들 **코드 스플리팅** 보강 — vendor 청크 세분화
- 사이드바 V7 등록 ID fetch를 **경량 endpoint**로 전환
- 통합 도움말에 '문서 가이드' 탭 추가
- 한국표준산업분류별 서식 메뉴

---

## 11. 타입 안전성 대규모 정비 (부수적이지만 대량)

- **약 9,000+ 커밋**이 TypeScript 타입 정합성 수정
- 18차에 걸친 batch fix (as any → 정확한 타입)
- TS2304, TS2339, TS2741 등 체계적 해결
- ESLint rule 추가 (jsx-no-leaked-render 등)

---

## 카테고리별 커밋 비중 (추정)

| 카테고리 | 비중 |
|---------|------|
| TypeScript/타입 안전성 | ~80% |
| V7 에디터 | ~8% |
| 전문가 ERP | ~4% |
| i18n 다국어 | ~3% |
| 기업법무 | ~1.5% |
| 채팅/통신 | ~1% |
| 기타 (SEO, LDrive, AI 등) | ~2.5% |

---

*생성일: 2026-05-11*
*생성 도구: claude-telegram-bot orchestrator*
