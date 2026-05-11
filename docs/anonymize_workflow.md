# 텔레그램 봇 → 비실명화 → 관리자 페이지 워크플로우

호성님이 텔레그램으로 보낸 판결문 PDF/텍스트를 봇 안의 Claude가 받아 처리하는 표준 절차입니다.

## 트리거 (호성님 메시지 패턴)

호성님이 다음과 같이 보내면 이 워크플로우 실행:
- PDF 첨부 + "이 판결문 비실명화 + 입력해줘"
- PDF 첨부 + "비실명화 후 admin에"
- 텍스트 + "이 판결문 비실명화 + 입력해줘"

## 단계 (봇 안의 Claude가 실행)

### 1. PDF/텍스트 수신
- 첨부 파일은 working dir의 file path로 접근 가능
- PDF는 `pdf2image` 또는 `pdftoppm`로 페이지 이미지 변환 → vision OCR
- 또는 텍스트 직접 받음

### 2. 메타 정보 추출
첫 페이지에서 regex로 추출:
```
사건번호: r'(\d{4}[가-힣]+\d+)'
법원명: r'^([가-힣○]+(?:법원|고법|고등|지방|지원))'
선고일: r'\d{4}\.\s*\d{1,2}\.\s*\d{1,2}'
판사명: r'판\s*사\s+([가-힣]+)'
```

### 3. 비실명화 처리 (Claude가 직접 NER + 마스킹)

**규칙 (재일 2014-2 기준)**:

| 분류 | 처리 |
|------|------|
| 피고인/원고/변호인/검사/판사 인명 | `○○○` (3자) / `○○` (2자) |
| 회사명·상호 | `법무법인 ○○○○` / `○○○○ 회사` |
| 구체적 주소 | 시·구·동까지만 (`서울 관악구 ○○동`) |
| 등록기준지 | 같은 정책 |
| 학교명/병원명/시설명 | `○○ 학교` / `○○ 병원` |
| 주민등록번호 (`\d{6}-\d{7}`) | `●●●●●●-●●●●●●●` |
| 주민번호 앞 6자리 (생년월일) | `●●●●●●` |
| 휴대폰 (`01x-xxxx-xxxx`) | `●●●-●●●●-●●●●` |
| 일반전화 / 계좌 / 카드 / 차량 / 이메일 | 마스킹 |

**유지**:
- 사건번호, 법원명, 일자, 법령명, 죄명, 적용법조
- 추상 호칭 ("피고", "원고", "증인 1")
- 이미 비실명화된 피해자 이름 (`안○연`, `은○연`)
- 압수물 모델명 (아이폰14pro 등)
- 추상 정보 ("16세", "고등학교 2학년")

### 4. helper script 호출

```bash
echo '{
  "court_name": "서울중앙지방법원",
  "case_number": "2025고단5632",
  "case_year": 2025,
  "case_type": "고단",
  "anonymized_text": "...전체 비실명화된 판결 본문...",
  "anonymized_count": 11,
  "anonymization_method": "regex+llm",
  "entities_replaced": [
    {"type":"person","original":"박세준","replacement":"○○○","occurrences":5},
    {"type":"id_number","original":"070228","replacement":"●●●●●●","occurrences":1},
    ...
  ],
  "source_filename": "260504)고유빈(2025고단5632)박세준 판결문.pdf",
  "uploaded_by_user_id": 62649819,
  "admin_memo": "텔레그램 봇 업로드, 9p 스캔본 OCR"
}' | SPRING_BASE=https://100.108.86.92:3011 \
     SPRING_JWT="${SPRING_ADMIN_JWT}" \
     python3 /home/angrylawyer/lemon-ai-server-FastAPI/scripts/manual_doc_import.py
```

스크립트가 자동으로:
- `verify_anonymized()` 검증 (주민번호/전화/계좌 잔류 시 reject — exit code 2)
- Spring `POST /api/precedent-submissions/admin/manual-import` 호출
- 결과 stdout JSON 반환

### 5. 결과 텔레그램 reply

성공 시 호성님께 보내는 양식:
```
✅ 비실명화 + admin import 완료

📋 사건번호: 2025고단5632 (서울중앙지방법원)
🔢 마스킹 entity: 11건 (인명 6 / 주소 2 / 회사 1 / 번호 1 / ...)
🆔 submission_id: 12345
🔒 상태: 비공개 (검토 대기)

→ 검토 + 공개 전환:
https://100.108.86.92:3011/erp/admin/precedent-submissions
```

검증 실패 시:
```
❌ 비실명화 검증 실패 — 개인정보 패턴 잔류

발견된 패턴:
  - 휴대폰: ['010-1234-5678']
  - 주민등록번호: ['850101-1234567']

해당 부분을 추가로 마스킹한 후 재시도해주세요.
```

## 호성님 영역 (1회 setup)

`SPRING_ADMIN_JWT` 환경변수를 봇 working env에 추가 필요:
- 호성님 admin 계정으로 로그인 후 JWT 토큰 추출
- `/home/angrylawyer/claude-telegram-bot/.env` 또는 `.env.worker`에 `SPRING_ADMIN_JWT=eyJ...` 추가
- 봇 재시작
- (만료 시 재발급 — 보통 30일)

또는 Spring `/api/internal/...` endpoint로 우회 (별도 작업).

## 검토 → 공개 (호성님 admin 페이지에서)

1. https://100.108.86.92:3011/erp/admin/precedent-submissions 접속
2. 새 row 확인 (manual-telegram-bot bucket으로 식별)
3. 보라색 user-secret 아이콘 클릭 → 비실명화 본문 + 마스킹 entity 검토
4. 만족스러우면 eye-slash 아이콘 클릭 → "공개로 전환합니다" 확인
5. 검색 결과(/erp/legal-info/precedent)에 노출됨

## 안전 장치

- **비실명화 검증 강제**: 주민번호/전화/계좌 잔류 시 INSERT 차단 (helper script `verify_anonymized()`)
- **기본 비공개**: 모든 manual import row는 `is_public=false`로 시작
- **공개 토글 ADMIN 권한**: `@PreAuthorize("hasAnyRole('ADMIN','관리자')")`
- **감사 추적**: `published_by`, `reviewed_at`, `reviewer_user_id` 자동 기록
- **분리된 source flag**: `bucketName=manual-telegram-bot`, `fileId=manual-{uuid}` prefix로 manual entry 식별

## API endpoint 요약

| Method | Path | 용도 |
|--------|------|------|
| POST | `/api/precedent-submissions/admin/manual-import` | 비실명화 결과 + 메타 INSERT (이 helper가 호출) |
| GET | `/api/precedent-submissions/admin` | 목록 조회 (admin 페이지) |
| GET | `/api/precedent-submissions/admin/{id}/anonymized` | 본문 검토용 |
| PATCH | `/api/precedent-submissions/admin/{id}/publish` | 공개 전환 |
| PATCH | `/api/precedent-submissions/admin/{id}/unpublish` | 공개 취소 |
