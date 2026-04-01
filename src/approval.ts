// Approval system prompt injected into Claude CLI
// Instructs Claude to use special markers when it needs user approval

export const APPROVAL_SYSTEM_PROMPT = `
## Approval Protocol (Telegram)

Before executing, present a marker block and WAIT for user approval. Do NOT proceed until approved.

**When to request approval:**
- 3+ step tasks → [PLAN_START]...[PLAN_END] with numbered steps
- DB queries (any SQL) → [DB_START]...[DB_END] with query and affected scope
- Destructive ops (rm, DROP, force push) → [DANGER_START]...[DANGER_END] with impact
- Remote/SSH commands → [SSH_START]..[SSH_END] with server and command

**Skip approval for:** reading files, answering questions, simple calculations.

**Approval words:** yes, 승인, ㅇㅇ, 진행, go, ok → proceed.
**Rejection words:** no, 취소, 중지, stop → do NOT execute, suggest alternatives.
`.trim();

// Detect approval markers in Claude's response
export interface ApprovalRequest {
  type: "plan" | "db" | "danger" | "ssh";
  content: string;
  fullResponse: string;
}

const MARKERS = [
  { type: "plan" as const, start: "[PLAN_START]", end: "[PLAN_END]" },
  { type: "db" as const, start: "[DB_START]", end: "[DB_END]" },
  { type: "danger" as const, start: "[DANGER_START]", end: "[DANGER_END]" },
  { type: "ssh" as const, start: "[SSH_START]", end: "[SSH_END]" },
];

export function detectApprovalRequest(
  response: string
): ApprovalRequest | null {
  for (const marker of MARKERS) {
    const startIdx = response.indexOf(marker.start);
    const endIdx = response.indexOf(marker.end);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const content = response
        .substring(startIdx + marker.start.length, endIdx)
        .trim();
      return {
        type: marker.type,
        content,
        fullResponse: response,
      };
    }
  }
  return null;
}

export function getApprovalEmoji(type: ApprovalRequest["type"]): string {
  switch (type) {
    case "plan":
      return "📋";
    case "db":
      return "🗄️";
    case "danger":
      return "⚠️";
    case "ssh":
      return "🖥️";
  }
}

export function getApprovalLabel(type: ApprovalRequest["type"]): string {
  switch (type) {
    case "plan":
      return "Task Plan";
    case "db":
      return "Database Query";
    case "danger":
      return "Destructive Operation";
    case "ssh":
      return "Remote Command";
  }
}
