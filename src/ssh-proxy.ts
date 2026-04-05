/**
 * SSH Proxy — WebSocket ↔ SSH 브릿지
 *
 * 프론트엔드 xterm.js에서 WebSocket으로 접속하면
 * 워커 서버에 SSH 연결을 생성하고 양방향 스트리밍.
 */

import { Client as SSHClient } from "ssh2";
import { readFileSync } from "fs";

const SSH_PROXY_PORT = parseInt(process.env.SSH_PROXY_PORT || "9000");
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || "/home/angrylawyer/.ssh/id_ed25519";
const PROXY_SECRET = process.env.RESTART_SECRET || "lemonclaw-restart-2024";

// 워커별 SSH 접속 정보
interface ServerConfig { host: string; port: number; username: string; }

const SERVER_MAP: Record<string, ServerConfig> = {
  "3060":          { host: "100.66.165.128",  port: 2225, username: "angrylawyer" },
  "a4500":         { host: "182.227.106.181", port: 2223, username: "angrylawyer" },
  "macmini":       { host: "100.122.231.38",  port: 22,   username: "angrylawyermacminihome" },
  "rtx4060":       { host: "100.87.245.113",  port: 2224, username: "angrylawyer" },
  "3rdwin":        { host: "100.86.44.119",   port: 2223, username: "angrylawyer" },
  "davolink":      { host: "100.117.62.40",   port: 22,   username: "angrylawyer" },
  "ui-macmini":    { host: "100.73.206.111",  port: 22,   username: "ui_macmini" },
  "rtx4090":       { host: "100.74.93.52",    port: 2222, username: "angrylawyer" },
  "m4mini-office": { host: "100.99.191.66",   port: 22,   username: "angrylawyer" },
};

let privateKey: Buffer | null = null;
try { privateKey = readFileSync(SSH_KEY_PATH); } catch (e: any) {
  console.warn(`[SSH-Proxy] Cannot read key: ${SSH_KEY_PATH} — ${e.message}. SSH Proxy disabled.`);
}

const activeSessions = new Map<any, { client: SSHClient; stream: any }>();

export function startSshProxy(): void {
  if (!privateKey) { console.warn("[SSH-Proxy] No private key, skipping."); return; }
  Bun.serve({
    port: SSH_PROXY_PORT,
    fetch(req, server) {
      const url = new URL(req.url);

      // Health
      if (url.pathname === "/health") {
        return Response.json({ ok: true, role: "ssh-proxy", sessions: activeSessions.size, servers: Object.keys(SERVER_MAP) });
      }

      // 서버 목록
      if (url.pathname === "/servers") {
        return Response.json({ ok: true, servers: Object.entries(SERVER_MAP).map(([name, cfg]) => ({ name, host: cfg.host, port: cfg.port, username: cfg.username })) });
      }

      // WebSocket 업그레이드
      if (url.pathname === "/ssh") {
        const serverName = url.searchParams.get("server");
        const secret = url.searchParams.get("secret");
        // nginx auth_request 경유 시 X-Forwarded-For 헤더가 있으면 인증 통과 (nginx가 JWT 검증)
        const isNginxProxy = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip");
        if (!isNginxProxy && secret !== PROXY_SECRET) {
          return new Response("Unauthorized", { status: 403 });
        }
        if (!serverName || !SERVER_MAP[serverName]) {
          return new Response(`Unknown server: ${serverName}`, { status: 400 });
        }

        const success = server.upgrade(req, { data: { serverName } });
        return success ? undefined : new Response("Upgrade failed", { status: 500 });
      }

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        }});
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        const { serverName } = ws.data as { serverName: string };
        const config = SERVER_MAP[serverName];
        if (!config) { ws.send(JSON.stringify({ type: "error", data: "Unknown server" })); ws.close(); return; }

        ws.send(JSON.stringify({ type: "status", data: `Connecting to ${serverName} (${config.host}:${config.port})...` }));

        const client = new SSHClient();

        client.on("ready", () => {
          client.shell({ term: "xterm-256color", cols: 120, rows: 30 }, (err, stream) => {
            if (err) {
              ws.send(JSON.stringify({ type: "error", data: `Shell error: ${err.message}` }));
              client.end();
              return;
            }

            activeSessions.set(ws, { client, stream });
            ws.send(JSON.stringify({ type: "ready", data: `Connected to ${serverName}` }));

            stream.on("data", (chunk: Buffer) => {
              ws.send(JSON.stringify({ type: "output", data: chunk.toString("utf8") }));
            });

            stream.stderr?.on("data", (chunk: Buffer) => {
              ws.send(JSON.stringify({ type: "output", data: chunk.toString("utf8") }));
            });

            stream.on("close", () => {
              activeSessions.delete(ws);
              try { ws.close(); } catch {}
            });
          });
        });

        client.on("error", (err) => {
          ws.send(JSON.stringify({ type: "error", data: `SSH error: ${err.message}` }));
          activeSessions.delete(ws);
          try { ws.close(); } catch {}
        });

        client.connect({
          host: config.host,
          port: config.port,
          username: config.username,
          privateKey,
          readyTimeout: 15000,
        });
      },

      message(ws, message) {
        const session = activeSessions.get(ws);
        if (!session) return;
        try {
          const msg = JSON.parse(typeof message === "string" ? message : message.toString());
          if (msg.type === "input") {
            session.stream.write(msg.data);
          } else if (msg.type === "resize" && msg.cols && msg.rows) {
            session.stream.setWindow(msg.rows, msg.cols, 0, 0);
          }
        } catch {}
      },

      close(ws) {
        const session = activeSessions.get(ws);
        if (session) {
          try { session.stream.destroy(); } catch {}
          try { session.client.end(); } catch {}
          activeSessions.delete(ws);
        }
      },
    },
  });

  console.log(`[SSH-Proxy] Listening on port ${SSH_PROXY_PORT} (${Object.keys(SERVER_MAP).length} servers)`);
}
