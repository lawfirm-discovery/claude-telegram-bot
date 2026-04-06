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
