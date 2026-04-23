# Heartbeat Checklist

하트비트 시 아래 항목을 Bash 도구로 실제 확인하세요.
문제가 있으면 즉시 텔레그램으로 알려주세요.

## 1. 맥미니 앱서버 (100.88.75.47) 서비스 상태
- [ ] 앱서버 접속: 200 → 200 또는 30x

## 2. n100 로컬 상태
- [ ] 디스크 사용량 90% 미만인지 확인 (Filesystem                         Size  Used Avail Use% Mounted on
/dev/mapper/ubuntu--vg-ubuntu--lv  232G  131G   91G  59% /)
- [ ] 메모리 사용량 95% 미만인지 확인 (               total        used        free      shared  buff/cache   available
Mem:            7681        2902         433         199        4856        4779
Swap:           4095         640        3455)
- [ ] PostgreSQL 동작 확인: localhost:5432 - accepting connections → accepting connections

## 판정 규칙
- 모든 항목 정상 → HEARTBEAT_OK만 응답 (사용자에게 메시지 보내지 않음)
- 맥미니 앱서버 다운 → 즉시 알림
- PostgreSQL 다운 → 즉시 알림
- 디스크/메모리 위험 → 즉시 알림
- curl 타임아웃(5초 이상)도 비정상으로 간주
