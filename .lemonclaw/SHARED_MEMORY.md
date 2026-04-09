# Shared Memory — 봇 간 작업 공유

최근 작업 내역 (최신순):

- [2026. 4. 4. 오후 10:02:02] **rtx6000_claude_style_bot**: lemon-front Login.tsx 수정 — 로그인 리다이렉트 버그 수정 (dev-hs-rtx6000-new)
- [2026. 4. 4. 오후 10:02:02] **rtx6000_claude_style_bot**: lemon-api-server-spring AuthController.java — refreshToken 엔드포인트 추가
- [2026. 4. 4. 오후 10:02:02] **rtx6000_claude_style_bot**: lemon-front Login.tsx 수정 — 로그인 리다이렉트 버그 수정 (dev-hs-rtx6000-new)
- [2026. 4. 4. 오후 10:02:02] **rtx6000_claude_style_bot**: lemon-api-server-spring AuthController.java — refreshToken 엔드포인트 추가
- [2026. 4. 4. 오후 10:51:52] **angrylawyer_a4500_basement_bot**: 여기 유니버셜 모달에서 이미지 캡쳐의 경우 2번째 사진이 중복되어 렌더링 되는데 탭 제목에 이미지 캡쳐가 있으니 굳이 중복해서 렌덩할 필요가 없 → 이제 전체 구조를 파악했습니다. 설계안을 제시합니다.
---
## 설계안: 이미지 캡쳐 3가지 이슈 수정
### 1. 중복 헤더 제거 (FileCapture.tsx)
- **현재**: `isModal=true`
- [2026. 4. 4. 오후 11:34:52] **angrylawyer_a4500_basement_bot**: 지금 유니버셜 모달의 파일 헤더 부분의 아이콘들을 유니버셜 모달 헤더의 오른쪽 끝으로 중복을 제거하고 이동하는 방식으로 개선을 해줘2번째 사진  → 완료. 푸시 성공.
**변경 내용:**
- 뷰어 헤더(2번째 줄) 완전 제거 — 103줄 삭제
- 모달 헤더 파일명 행 오른쪽에 아이콘 통합: 줌컨트롤(`- 100% + ⛶`) | 다운로드, 새창열기, 패널토글
-
- [2026. 4. 4. 오후 11:42:27] **angrylawyer_a4500_basement_bot**: 아니 시발 2번째 줄 이거는 그대로 두고 왼쪽 패널의 파일 뷰어 바로 상단의 헤더에 있는 아이콘을 1줄 오른쪽 끝으로 옮겨라고, 파일 타입 가리 → 수정 완료. 푸시 성공.
**변경 내용:**
- 뷰어 아이콘(다운로드, 외부앱, 새창, 패널토글)을 **1번째 줄 오른쪽** (전체화면/닫기 왼쪽)으로 이동
- 이미지/엑셀은 줌 컨트롤도 함께 표시
- **모든 파
- [2026. 4. 5. 오전 2:16:23] **rtx6000_claude_style_bot**: https://100.108.86.92:3011/erp/organization/lemon-store/products/new?organizatio → 수정 완료, 푸시 성공.
**원인**: `Sidebar.tsx:1327`의 `numericIdSegments` 배열에 `:productId`가 없어서, `/products/new` 경로의 "new"가 `:produ
- [2026. 4. 6. 오후 6:50:14] **angrylawyer_rtx4060_win_bot**: 지금 mcp 칩의 이름이 사건이름을 제대로 렌더링을 못하는 문제가 여전함. 그리고 2번째 사진처럼 칩을 열어 사건상세정보 모달이 뜰때 밤테인데, → 스크린샷 확인. 여전히 "형사소송 #319"만 표시됨. 두 가지 문제를 조사합니다.
1. **사건 칩 이름**: Spring API의 list 응답에 `caseType1`/`caseType2`/`clientName
- [2026. 4. 6. 오후 6:52:47] **angrylawyer_rtx4060_win_bot**: 이 이미지를 분석해줘 → 사건 상세 모달 스크린샷 확인.
**다크테마 이슈가 보입니다:**
- 상단 헤더(보라색 그라데이션) + 탭 바: 다크 적용됨
- **사건 정보 영역(하단 카드)**: 흰색 배경 + 검정 텍스트 → **라이트 테마*
- [2026. 4. 7. 오후 10:12:40] **angrylawyer_rtx4060_win_bot**: https://100.108.86.92:3011/erp/organization/lemon-store/products/new?organizatio → 스크린샷 확인. 모바일에서 글자가 크고 여백이 과다해서 한 화면에 정보가 적게 보이는 문제. 래몬스토어 상품 등록 관련 컴포넌트를 찾겠습니다.메인 파일 확인. 모바일에서 글자/패딩이 큰 부분들을 읽어보겠습니다.전체
- [2026. 4. 9. 오후 3:00:46] **angrylawyer_rtx6000_basement_bot**: 문서를 작성하고 있습니다 이 에메이션 ui가 화면 줄의 폭이 짤려 있는 문제, 그리고 생성을 하면 2번째 화면인데, 리프레쉬를 하면3번째 사진처 → 
Let me look at the screenshots first.이미지 1장만 보입니다 (생성 중 프로그레스 바 화면). 2번째/3번째 스크린샷도 있으면 보내주세요.
우선 보이는 이슈와 관련 코드를 찾겠습니다
- [2026. 4. 9. 오후 5:31:09] **angrylawyer_rtx6000_basement_bot**: 그리고 생성한 문서 초안의 내용이 여전히 너무 줄글로 보이고 전혀 문서 형식으로 보이지가 않아~ v7 스키마 문서생성기를 쓴다면 스타일 정보도  → 스크린샷 확인. 계약서가 완전 줄글로 렌더링되고 있네요. v7 스키마 문서생성기와 렌더링 부분을 조사하겠습니다.핵심 렌더링 코드를 확인하겠습니다.이제 v7 리스트 마커 함수도 확인하겠습니다.이제 전체 구조를 파악했습
- [2026. 4. 9. 오후 6:11:59] **angrylawyer_rtx6000_basement_bot**: se: 2, …}
overrideMethod @ installHook.js:1
console.error @ index.js:65
i.onerro → DOCX 다운로드 에러. `v7NativeToIR`에서 `documentType`을 읽지 못하는 문제. 확인하겠습니다.31줄에서 `doc.metadata.documentType` 접근 시 `doc.metadata`가
- [2026. 4. 9. 오후 6:18:12] **angrylawyer_rtx6000_basement_bot**: 그리고 지금 생성된 문서를 첨부해서 상담을 받을때, 문서생성의 경우에 생성된 문서를 일반 텍스트가 아니라 v7 에디터와 호환되는 문서로 취급해서 → 스크린샷 확인. 2가지 요청:
1. **전문가 상담 시 v7 문서를 에디터 호환 형태로 전달** — 전문가가 클릭해서 문서작성에서 열 수 있도록
2. **상담 모달의 "AI 대화" 영역에 보더/카드 효과로 가독성 개
- [2026. 4. 9. 오후 11:49:18] **angrylawyer_rtx6000_basement_bot**: 여기 제목을 변경된 이름으로 개선 세련된 텍스트 로고로 → 완료. 변경 내용:
- **데스크탑**: `CHRONOS` — 첫 글자 `C`만 블루 강조(`font-semibold`), 나머지는 `font-extralight` + 넓은 자간(`tracking-[0.25em]`
- [2026. 4. 9. 오후 11:51:48] **angrylawyer_rtx6000_basement_bot**: 그리고 지금 디비내용이 개선된 설계와 안맞아서 캔버스에 카드와 연결선이 이상하케 꼬여있으니 검증해봐 → 카드 1개만 보이고 연결선들이 화면 밖으로 길게 뻗어 있네요. DB 데이터와 레이아웃 로직을 조사하겠습니다.조사 완료. 핵심 문제 파악됨. 상세 확인하겠습니다.핵심 문제 파악 완료.

## 진단 결과

**1. 날짜
