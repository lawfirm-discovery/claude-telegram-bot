import { spawn } from "child_process";
import { InlineKeyboard } from "grammy";
import { writeFile, unlink, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export type YouTubeVideo = {
  id: string;
  title: string;
  uploader: string;
  duration: number;
  url: string;
  description: string;
  view_count: number;
  tags: string[];
};

export type YouTubeSession = {
  state: "awaiting_query" | "selecting";
  query: string;
  results: YouTubeVideo[];
  selected: Set<number>;
  messageId?: number;
};

export const ytSessions = new Map<string, YouTubeSession>();

function spawnCollect(cmd: string, args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`${cmd} timeout`)); }, timeoutMs);
    proc.on("close", () => { clearTimeout(timer); resolve(stdout); });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function searchYouTube(query: string, count = 10): Promise<YouTubeVideo[]> {
  const raw = await spawnCollect("yt-dlp", [
    `ytsearch${count}:${query}`,
    "--dump-json",
    "--flat-playlist",
  ]);

  const videos: YouTubeVideo[] = [];
  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      videos.push({
        id: obj.id,
        title: obj.title || "Unknown",
        uploader: obj.uploader || obj.channel || "Unknown",
        duration: obj.duration || 0,
        url: `https://www.youtube.com/watch?v=${obj.id}`,
        description: (obj.description || "").slice(0, 500),
        view_count: obj.view_count || 0,
        tags: Array.isArray(obj.tags) ? obj.tags.slice(0, 10) : [],
      });
    } catch {}
  }
  return videos;
}

export async function fetchVideoDetails(video: YouTubeVideo): Promise<string> {
  const tmpBase = join(tmpdir(), `yt-${video.id}`);

  // Full metadata
  let meta = "";
  try {
    meta = await spawnCollect("yt-dlp", [
      video.url,
      "--dump-json",
      "--no-playlist",
    ], 20000);
  } catch {}

  let fullDesc = video.description;
  let tags = video.tags;
  let viewCount = video.view_count;
  let likeCount = 0;
  let uploadDate = "";

  if (meta) {
    try {
      const obj = JSON.parse(meta.trim());
      fullDesc = (obj.description || "").slice(0, 1000);
      tags = Array.isArray(obj.tags) ? obj.tags.slice(0, 15) : [];
      viewCount = obj.view_count || viewCount;
      likeCount = obj.like_count || 0;
      uploadDate = obj.upload_date || "";
    } catch {}
  }

  // Subtitles (auto-generated, Korean first then English)
  let transcript = "";
  try {
    await spawnCollect("yt-dlp", [
      video.url,
      "--write-auto-subs",
      "--sub-langs", "ko,en",
      "--skip-download",
      "--no-playlist",
      "-o", tmpBase,
    ], 30000);

    for (const lang of ["ko", "en"]) {
      const vttPath = `${tmpBase}.${lang}.vtt`;
      if (existsSync(vttPath)) {
        const content = await readFile(vttPath, "utf-8");
        transcript = parseVTT(content).slice(0, 3000);
        unlink(vttPath).catch(() => {});
        break;
      }
    }
  } catch {}

  const dur = formatDuration(video.duration);
  const views = viewCount > 0 ? `${viewCount.toLocaleString()}회` : "N/A";
  const likes = likeCount > 0 ? `${likeCount.toLocaleString()}개` : "N/A";
  const dateStr = uploadDate
    ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
    : "N/A";

  let detail = `제목: ${video.title}
채널: ${video.uploader}
URL: ${video.url}
길이: ${dur}
조회수: ${views}
좋아요: ${likes}
업로드: ${dateStr}`;

  if (tags.length > 0) detail += `\n태그: ${tags.join(", ")}`;
  if (fullDesc) detail += `\n\n설명:\n${fullDesc}`;
  if (transcript) detail += `\n\n자막/스크립트:\n${transcript}`;

  return detail;
}

function parseVTT(vtt: string): string {
  return vtt
    .split("\n")
    .filter(line => {
      const t = line.trim();
      return t !== "" &&
        !t.startsWith("WEBVTT") &&
        !t.match(/^\d{2}:\d{2}:\d{2}\.\d{3} --> /) &&
        !t.match(/^\d+$/) &&
        !t.startsWith("Kind:") &&
        !t.startsWith("Language:");
    })
    .map(l => l.replace(/<[^>]+>/g, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatDuration(seconds: number): string {
  if (!seconds) return "N/A";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function buildYTKeyboard(session: YouTubeSession): InlineKeyboard {
  const kb = new InlineKeyboard();
  session.results.forEach((v, i) => {
    const icon = session.selected.has(i) ? "✅" : "⬜";
    const title = v.title.slice(0, 35);
    const dur = formatDuration(v.duration);
    kb.text(`${icon} ${i + 1}. ${title} (${dur})`, `yt_toggle:${i}`).row();
  });
  const n = session.selected.size;
  if (n > 0) {
    kb.text(`🤖 분석 시작 (${n}개 선택)`, "yt_analyze").text("❌ 취소", "yt_cancel");
  } else {
    kb.text("🔄 새 검색", "yt_new").text("❌ 취소", "yt_cancel");
  }
  return kb;
}

export function buildYTResultMessage(session: YouTubeSession): string {
  const lines = [`🔍 <b>검색: ${escTg(session.query)}</b> — ${session.results.length}개 결과\n`];
  session.results.forEach((v, i) => {
    const icon = session.selected.has(i) ? "✅" : "⬜";
    const dur = formatDuration(v.duration);
    const views = v.view_count > 0 ? ` · ${(v.view_count / 1000).toFixed(0)}K뷰` : "";
    lines.push(`${icon} <b>${i + 1}.</b> ${escTg(v.title)}`);
    lines.push(`   └ ${escTg(v.uploader)} · ${dur}${views}`);
  });
  lines.push(`\n항목을 선택한 후 분석 버튼을 누르세요.`);
  return lines.join("\n");
}

function escTg(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
