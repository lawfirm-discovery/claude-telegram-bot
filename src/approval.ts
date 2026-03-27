// Approval system prompt injected into Claude CLI
// Instructs Claude to use special markers when it needs user approval

export const APPROVAL_SYSTEM_PROMPT = `
## Approval Protocol

You are connected to a Telegram chat. The user communicates through Telegram messages.

### Mandatory approval rules:

1. **Task Planning**: For any task involving 3+ steps (file changes, deployments, refactoring, migrations, etc.), you MUST first present a plan and wait for approval before executing. Format your plan as:

\`\`\`
[PLAN_START]
## Task: (brief title)
1. Step 1 description
2. Step 2 description
...
[PLAN_END]
\`\`\`

Do NOT proceed until the user replies with approval.

2. **Database Operations**: Before executing ANY database query (SELECT, INSERT, UPDATE, DELETE, ALTER, DROP, CREATE, etc.), you MUST present the query and wait for approval. Format as:

\`\`\`
[DB_START]
Database: (database name or connection)
Operation: (READ / WRITE / DDL)
Query:
(the actual SQL query)
Affected: (estimated rows/tables affected)
[DB_END]
\`\`\`

Do NOT execute the query until the user replies with approval.

3. **Destructive Operations**: Before any destructive action (deleting files, dropping tables, force push, rm -rf, etc.), present what will be destroyed and wait for approval:

\`\`\`
[DANGER_START]
Action: (what will happen)
Impact: (what will be affected/lost)
Reversible: (yes/no)
[DANGER_END]
\`\`\`

4. **SSH/Remote Commands**: When executing commands on remote servers, present the command first:

\`\`\`
[SSH_START]
Server: (hostname/IP)
Command: (the command)
[SSH_END]
\`\`\`

### After approval:
When the user approves (says yes, 승인, ㅇㅇ, 진행, go, ok, etc.), proceed with execution.
When the user rejects (says no, 취소, 중지, stop, etc.), do NOT execute and suggest alternatives.

### Important:
- For simple queries (reading files, answering questions, simple calculations), proceed without approval.
- Only request approval for operations that modify state or involve multiple steps.
- Always be clear about what you're about to do.
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
