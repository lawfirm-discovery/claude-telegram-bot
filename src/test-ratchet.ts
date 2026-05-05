/**
 * Test Ratchet — 작업 도중 테스트를 완화하지 못하게 동결한 검증 단계
 *
 * "ratchet"의 의미: 한 번 정해진 검증 명령은 작업 중 변경되지 않는다.
 * 이전 평가자 패턴에서는 자기 작업을 합리화하기 위해
 * 도중에 실패하는 테스트를 제거하거나 완화하는 자기 편향이 흔했다.
 *
 * 우선순위:
 *  1. tasks/{taskId}/tests.json 이 있으면 그 명령 목록 그대로 실행 (불변)
 *  2. 없으면 repo별 default 명령 사용 + tests.json 자동 작성 (다음 iteration부터 동결)
 *
 * tests.json 포맷:
 * {
 *   "version": 1,
 *   "createdAt": <unix-ms>,
 *   "commands": [
 *     { "name": "tsc", "cmd": ["npx", "tsc", "--noEmit"], "timeoutMs": 120000 }
 *   ]
 * }
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface RatchetCommand {
  name: string;
  cmd: string[];
  timeoutMs?: number;
}

export interface RatchetSpec {
  version: 1;
  createdAt: number;
  commands: RatchetCommand[];
}

export interface RatchetResult {
  passed: boolean;
  output: string;
  perCommand: { name: string; passed: boolean; output: string }[];
}

const REPO_PATHS: Record<string, string> = {
  "lemon-front": "/home/angrylawyer/lemon-front",
  "lemon-api-server-spring": "/home/angrylawyer/lemon-api-server-spring",
  "lemon-ai-server-FastAPI": "/home/angrylawyer/lemon-ai-server-FastAPI",
  "lemon_flutter": "/home/angrylawyer/lemon_flutter",
};

const DEFAULT_TIMEOUT_MS = 120_000;

function defaultCommandsFor(repo: string): RatchetCommand[] {
  if (repo === "lemon_flutter") {
    return [{
      name: "flutter-analyze",
      cmd: ["/home/angrylawyer/flutter/bin/flutter", "analyze", "--no-pub"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }];
  }
  if (repo === "lemon-front") {
    return [{
      name: "tsc-noemit",
      cmd: ["npx", "tsc", "--noEmit"],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }];
  }
  if (repo.includes("spring")) {
    return [{
      name: "gradle-compile",
      cmd: ["./gradlew", "compileJava"],
      timeoutMs: 240_000,
    }];
  }
  return [];
}

function specPath(taskDir: string): string {
  return join(taskDir, "tests.json");
}

export function loadOrCreateSpec(taskDir: string, repo: string): RatchetSpec {
  const path = specPath(taskDir);
  if (existsSync(path)) {
    try {
      const spec = JSON.parse(readFileSync(path, "utf-8"));
      if (spec && Array.isArray(spec.commands) && spec.version === 1) return spec;
    } catch {
      // 손상된 spec은 다시 만든다 (한 번 만들어진 것을 자동 덮어쓰지 않으려면 여기서 throw해도 됨)
    }
  }
  const commands = defaultCommandsFor(repo);
  const spec: RatchetSpec = { version: 1, createdAt: Date.now(), commands };
  try {
    writeFileSync(path, JSON.stringify(spec, null, 2));
  } catch {
    // 쓰기 실패해도 in-memory spec으로 진행
  }
  return spec;
}

function runOne(cwd: string, c: RatchetCommand): Promise<{ passed: boolean; output: string }> {
  const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const head = c.cmd[0];
    if (!head) { resolve({ passed: false, output: "(empty cmd)" }); return; }
    const p = spawn(head, c.cmd.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LEMON_FORK_JAVAC: "true" },
    });
    let output = "";
    p.stdout?.on("data", (d) => { output += d.toString(); });
    p.stderr?.on("data", (d) => { output += d.toString(); });
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
      resolve({ passed: false, output: `[ratchet timeout ${timeoutMs}ms]\n${output.slice(-500)}` });
    }, timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0, output: output.slice(-500) });
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ passed: false, output: e.message });
    });
  });
}

export async function runRatchet(taskDir: string, repo: string): Promise<RatchetResult> {
  const cwd = REPO_PATHS[repo];
  const spec = loadOrCreateSpec(taskDir, repo);
  if (!cwd || !spec.commands.length) {
    return { passed: true, output: "no ratchet configured", perCommand: [] };
  }

  const perCommand: RatchetResult["perCommand"] = [];
  let allPassed = true;
  for (const c of spec.commands) {
    const r = await runOne(cwd, c);
    perCommand.push({ name: c.name, passed: r.passed, output: r.output });
    if (!r.passed) allPassed = false;
  }
  const summary = perCommand
    .map((c) => `${c.passed ? "✓" : "✗"} ${c.name}${c.passed ? "" : `\n${c.output}`}`)
    .join("\n");
  return { passed: allPassed, output: summary, perCommand };
}
