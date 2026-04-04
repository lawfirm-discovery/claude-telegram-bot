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
