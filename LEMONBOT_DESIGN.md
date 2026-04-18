# LemonBot 제품 설계 문서
> 작성일: 2026-04-18

## 제품 정의

> **누구든 자신의 조직 홈페이지에 AI 상담봇을 만들어 붙일 수 있는 B2B SaaS 플랫폼**
> LegalMonster의 법률 특화 기능(법령/판례 RAG)은 그 중 하나의 옵션

---

## 대상 고객

| 업종 | 수요 |
|------|------|
| 법률사무소 | 초기 법률 문의 자동화 |
| 세무사/노무사 | FAQ 자동화 |
| 부동산 중개업소 | 매물 문의 자동 응대 |
| 병원/의원 | 증상 사전 안내, 예약 |
| 기업 내부 HR | 인사 규정 Q&A 자동화 |
| 일반 고객센터 | 제품/서비스 문의 자동화 |

**공통 수요**: 24/7 자동 응대 + 리드 수집 + 전문가 연결

---

## 봇 대화 처리 레이어

```
사용자 메시지 입력
        │
        ▼
Layer 0: FAQ 즉답 매칭 (토큰 소모 없음, <100ms)
  consultationConfig.faqTemplates에서 정확 매칭
  매칭 시 즉시 반환, 미매칭 시 다음 레이어
        │
        ▼
Layer 1: 커스텀 지식베이스 RAG
  FAISS (lemonbot_{bot_id}.faiss)
  봇별 문서/URL/Q&A 검색, 상위 3청크 추출
        │
        ▼ (feature_rag_legal=true인 경우만)
Layer 2: 법령/판례 RAG
  lawdocs FAISS 인덱스
  관련 법령 2개, 판례 2개 추출
        │
        ▼
Layer 3: LLM 응답 생성
  system_prompt + RAG 컨텍스트 주입
  SSE 스트리밍 응답
        │
        ▼
Layer 4: 에스컬레이션 판단
  "소송", "계약서", "상담 원해" 등 키워드 감지
  → 리드 수집 폼 표시 또는 핸드오프 요청 버튼
```

---

## 사용자 여정

### 여정 1: 조직 관리자 — 봇 만들기

```
ERP → 레몬봇 메뉴 → 봇 만들기

Step 1. 기본 설정
  - 봇 이름, 아바타, 환영 메시지
  - 응답 톤 (격식체/친근/전문)
  - 전문 분야 태그
  - 색상, 버튼 위치

Step 2. 지식베이스
  - PDF/Word 업로드
  - URL 추가 (홈페이지 크롤링)
  - Q&A 직접 입력
  - [선택] 법령/판례 검색 ON/OFF

Step 3. 임베드
  - 허용 도메인 입력
  - 임베드 코드 발급
  - 미리보기 테스트

→ 임베드 코드 홈페이지에 붙여넣기 → 봇 가동
```

### 여정 2: 외부 방문자 — 봇과 대화

```
고객 홈페이지 방문
  → (5~30초 후) 프로액티브 메시지 표시
  → 추천 질문 버튼 3개 (FAQ 상위 3개)
  → 자유 질문 입력 → Layer 0~3 처리 → 스트리밍 응답
  → N턴 대화 또는 상담 의도 감지 시
     "전문가와 상담하시겠어요?"
     [연락처 남기기] / [상담원 연결]
  → 리드 수집 완료 or 핸드오프
```

### 여정 3: 상담원 — ERP 관리

```
ERP → 레몬봇 → 내 봇
  ├─ 대화 이력: 방문자 질문 내역
  ├─ 리드 목록: 연락처 남긴 사람
  ├─ 상담 요청: 실시간 연결 대기
  │     [수락] → 라이브 채팅
  └─ 분석: 인기 질문, 전환율, 사용량
```

---

## 리걸몬스터 자체 봇 (특수 케이스)

```
동일한 플랫폼, 특별 설정:
  bot_id: 1 (lmbot_lm_official)
  feature_rag_legal: true   ← 법령/판례 RAG
  feature_lead: true        ← 리드 수집
  feature_escalation: true  ← 상담원 연결

추가 연동 (Phase 3):
  리드 → 회원가입 유도
  상담 연결 → 리걸몬스터 변호사 찾기
  대화 내용 → 상담 요청서(ConsultationRequest) 자동 생성
```

---

## 플랜/구독 모델

| 플랜 | 월 메시지 | 봇 수 | 가격 | 기능 |
|------|----------|-------|------|------|
| FREE | 500 | 1 | 무료 | Q&A만 |
| STARTER | 3,000 | 3 | 9,900원 | 문서+URL RAG, 리드수집 |
| PRO | 10,000 | 10 | 29,900원 | +법령RAG, 핸드오프, 분석 |
| ENTERPRISE | 100,000 | 100 | 99,000원 | +Webhook, API, 전용지원 |

---

## 기술 아키텍처

```
외부 사이트
  └─ widget.js (Shadow DOM, 플로팅 버튼)
       │
       ├─ GET  /api/lemonbot/public/{token}/config  → Spring → DB
       ├─ POST /api/lemonbot/public/{token}/session → Spring → DB
       ├─ POST /api/lemonbot/public/{token}/chat    → Spring → FastAPI(SSE)
       └─ POST /api/lemonbot/public/{token}/lead    → Spring → DB

리걸몬스터 내부
  └─ LemonBotFAB.tsx (MUI 컴포넌트)
       │
       ├─ GET  /api/lemonbot/public/{token}/config  → Spring
       ├─ POST /api/lemonbot/public/{token}/session → Spring
       └─ POST FastAPI직접/api/lemonbot/public/{token}/chat → FastAPI(SSE)

FastAPI 채팅 처리:
  1. Spring에서 봇 설정 조회
  2. Spring에서 세션 히스토리 조회
  3. FAQ 매칭 (Layer 0)
  4. 커스텀 FAISS RAG (Layer 1)
  5. 법령 FAISS RAG (Layer 2, 선택)
  6. LLM 스트리밍 (Layer 3)
  7. Spring에 메시지 저장
```

---

## 구현 로드맵

### Phase 1 — 작동 (즉시) ✅ 완료
- [x] Spring `/chat` 프록시 엔드포인트 추가 (Spring → FastAPI SSE 중계)
- [x] widget.js API URL 동적화 (data-api 속성)
- [x] LemonBotFAB camelCase 수정 (botId vs bot_id)
- [x] 지식소스 PENDING 재색인 트리거

### Phase 2 — 대화 품질 ✅ 완료
- [x] FAQ 즉답 레이어 (Layer 0) FastAPI에 추가
- [x] 에스컬레이션 키워드 감지 → CTA 트리거
- [x] 추천 질문 버튼 (widget.js + FAB)
- [x] URL 크롤러 구현 (BeautifulSoup)
- [x] 프로액티브 메시지 (15초 지연 팝업)

### Phase 3 — 화이트라벨 완성 ✅ 완료
- [x] CORS 봇별 허용 도메인 관리 (allowedOrigins, proxyChat 동적 검증)
- [x] 리드 → ConsultationRequest 자동 연동 (source=LEMONBOT, professional_id nullable)
- [x] 분석 대시보드 실데이터 차트 (Recharts AreaChart)
- [x] CSAT 만족도 수집 (star rating, /csat 엔드포인트)
- [x] 재방문자 이전 대화 복원 (visitorId 기반 세션 복원)

---

## 현재 코드 완성도 (2026-04-18 기준)

| 컴포넌트 | 완성도 | 비고 |
|----------|--------|------|
| DB 스키마 (8테이블) | 100% | professional_id nullable, lemonbot_session_id 추가 |
| Spring CRUD API | 100% | 완성 |
| Spring Public API | 100% | /chat SSE 프록시, CSAT, 재방문자 복원 완성 |
| FastAPI 채팅 SSE | 100% | 4-Layer 아키텍처 완성 |
| FastAPI RAG | 90% | FAISS 색인, URL 크롤러 완성 |
| 관리 UI | 95% | Recharts 분석 차트, AllowedOriginsEditor 완성 |
| widget.js | 95% | 추천칩, 에스컬레이션CTA, 프로액티브, CSAT, 복원 완성 |
| LemonBotFAB | 95% | camelCase 수정, 추천칩 완성 |
