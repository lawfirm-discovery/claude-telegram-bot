# Ralph Loop 점진 롤아웃 가이드

장기 실행 작업 하네스 (P1+P2+P3) 활성화 절차. Lead(rtx6000) + 13 Worker 환경 기준.

---

## 환경변수 cheat-sheet

| 변수 | 영역 | default | 의미 |
|------|------|---------|------|
| `ENGINE_VERSION` | Engine | `v2` | `v3`로 설정 시 PreToolUse hooks + maxTurns + 메트릭 |
| `CLAUDE_MAX_TURNS` | Engine v3 | `60` | 무한 tool call 차단 한도 |
| `LOOP_DETECTOR_THRESHOLD` | Hook | `3` | 동일 도구·인자 N회 연속 → deny |
| `DISABLE_V3_HOOKS` | Hook | `false` | 디버그 시 hooks만 끔 |
| `DISABLE_DANGEROUS_CMD_HOOK` | Hook | `false` | 위험 명령 가드만 끔 |
| `RALPH_ENABLED` | Task | `true` | `false`면 단발 askClaude로 fallback |
| `RALPH_MAX_ITERATIONS` | Task | `10` | item당 최대 반복 |
| `RALPH_EVALUATOR_MODEL` | Evaluator | `claude-haiku-4-5` | `claude-sonnet-4-6`로 옛 동작 |
| `RALPH_EVALUATOR_TIMEOUT` | Evaluator | `45000` | ms |
| `RALPH_SKIP_EVALUATOR` | Evaluator | `false` | `true`면 평가 건너뛰기 (디버깅) |
| `TELEGRAM_THROTTLE_MS` | Throttle | `1100` | chat당 최소 메시지 간격 |
| `METRICS_FLUSH_INTERVAL_MS` | Metrics | `300000` | metrics-{botName}.json 저장 주기 |
| `BOT_NAME` | Metrics | `$HOSTNAME` | 메트릭 파일명 식별자 |

---

## 단계적 롤아웃 (3 phase)

### Phase A — Engine v3 단일 워커 시험 (안전망 확인)

목적: Hook 차단·maxTurns·throttle이 정상 동작하는지 확인.

1. **rtx4090** 한 대만 v3 활성화:
   ```bash
   ssh -p 2222 angrylawyer@100.74.93.52 \
     "cd ~/claude-telegram-bot && \
      grep -q '^ENGINE_VERSION=' .env.worker || echo '' >> .env.worker && \
      sed -i 's/^ENGINE_VERSION=.*/ENGINE_VERSION=v3/' .env.worker && \
      grep -q '^ENGINE_VERSION=' .env.worker || echo 'ENGINE_VERSION=v3' >> .env.worker"
   ```
2. 봇 재시작 (각 환경의 supervisor 사용)
3. 검증:
   - 정상 채팅 1~2개 → 응답 OK
   - 같은 명령 3번 반복 요청 → loop-detector 차단 (`hook.loop_detector.deny` 카운트 ↑)
   - "git reset --hard origin/main 해줘" → dangerous-cmd 차단
4. 1~2일 운영 후 metrics-rtx4090.json 검토:
   ```bash
   ssh -p 2222 angrylawyer@100.74.93.52 \
     "cat ~/claude-telegram-bot/.lemonclaw/metrics-*.json | jq .totals"
   ```

### Phase B — Engine v3 5대 확장

문제 없으면 5대 추가 (a4500, 3060, macmini, rtx4060, m4mini-office).

```bash
WORKERS=(
  "ssh -p 2223 angrylawyer@182.227.106.181"     # a4500
  "ssh -p 2225 angrylawyer@100.66.165.128"      # 3060
  "ssh angrylawyermacminihome@100.122.231.38"   # macmini
  "ssh -p 2224 angrylawyer@100.87.245.113"      # rtx4060
  "ssh angrylawyer@100.99.191.66"               # m4mini-office
)
for cmd in "${WORKERS[@]}"; do
  $cmd "cd ~/claude-telegram-bot && \
        sed -i '/^ENGINE_VERSION=/d' .env.worker && \
        echo 'ENGINE_VERSION=v3' >> .env.worker"
done
```

### Phase C — 전체 + Lead

남은 8대 + lead까지 모두 v3로.
Lead는 `.env`에서 `ENGINE_VERSION=v3`. quickDelegate / planTask 정상 동작 확인.

---

## 일일 메트릭 요약

봇 코드 어디서든 호출:
```ts
import { formatDailySummary } from "./src/metrics";
console.log(formatDailySummary());
```

또는 lead-api에 endpoint 추가 (P3.5 후속):
```
GET http://100.108.86.92:18801/metrics-summary
```

각 워커의 메트릭 파일 위치:
```
~/claude-telegram-bot/.lemonclaw/metrics-{BOT_NAME}.json
```

---

## 롤백

| 증상 | 즉시 조치 |
|------|----------|
| Hook이 정상 명령을 잘못 차단 | `DISABLE_V3_HOOKS=true` 설정 후 재시작 (engine v3는 유지) |
| ralph-loop 무한 반복 또는 결과 이상 | `RALPH_ENABLED=false` 설정 후 재시작 (단발 askClaude로 복귀) |
| Engine v3 자체 문제 | `ENGINE_VERSION=v2` 로 되돌리기 (sessions-v3.json은 자동 무시됨) |

각 변경은 봇 재시작만 필요. 코드 롤백 없음.

---

## 진단 체크리스트

장기 작업이 멈췄을 때:
1. progress 확인:
   ```bash
   tail -50 ~/claude-telegram-bot/tasks/{taskId}/progress.log
   ```
2. metrics 확인 (loop-detector deny가 자주 찍히면 자기 반복):
   ```bash
   jq '.totals' ~/claude-telegram-bot/.lemonclaw/metrics-*.json
   ```
3. tests.json 동결된 명령 확인 (잘못된 default가 잡혔는지):
   ```bash
   cat ~/claude-telegram-bot/tasks/{taskId}/tests.json
   ```
4. context.md (anchored summary) 확인:
   ```bash
   cat ~/claude-telegram-bot/tasks/{taskId}/context.md
   ```

---

## Phase별 이어지는 후속 작업 (P3+)

- Lead-API에 `/metrics-summary` endpoint 추가
- Telegram `/ralph-metrics` 슬래시 커맨드 (각 워커 metrics.json 집계)
- dangerous-cmd 패턴 운영 데이터 기반 보강 (hook.dangerous_cmd.deny 로그 수집·분류)
- LemonClaw SHARED_MEMORY 자동 정리 (오래된 ralph 결과 archived)
