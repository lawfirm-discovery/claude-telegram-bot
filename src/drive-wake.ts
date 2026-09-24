export const SSD = "/Volumes/pylon_crucial p3 plus 2tb";

const POLL_MS = 500;

async function wakeIfNeeded(root: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // 실제 I/O 발생 → macOS가 슬립 중인 드라이브를 자동 spin-up
      await Bun.$`ls ${root}`.quiet();
      return;
    } catch {
      await Bun.sleep(POLL_MS);
    }
  }
  throw new Error(`외장 SSD 응답 없음 (${timeoutMs / 1000}초 초과): ${root}`);
}

/**
 * 외장 SSD가 필요한 작업을 래핑한다.
 * 슬립 중이면 자동으로 깨운 뒤 fn을 실행한다.
 *
 * @example
 * const data = await withDrive(() => Bun.file(`${SSD}/파일.mp4`).arrayBuffer());
 */
export async function withDrive<T>(
  fn: () => Promise<T>,
  { root = SSD, timeoutMs = 30_000 }: { root?: string; timeoutMs?: number } = {}
): Promise<T> {
  await wakeIfNeeded(root, timeoutMs);
  return fn();
}
