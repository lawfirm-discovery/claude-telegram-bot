// TEMPORARY STUB — 2026-08-25
// 5b2adea([pylon])가 src/bot.ts에 "./kiwoom" import를 추가했지만 kiwoom.ts 본체가
// 커밋되지 않아 전 워커봇이 "Cannot find module ./kiwoom" 크래시 루프에 빠짐.
// 원본 모듈(pylon99 머신에 존재 추정)이 커밋되면 이 스텁을 교체할 것.
// /broker 관련 명령은 스텁 안내 문구만 반환한다.

export async function getDailyMajorBrokers(_code?: any): Promise<any> {
  return null;
}

export function formatMajorBrokers(_result?: any, _code?: any): string {
  return "⚠️ 이 머신에는 kiwoom 모듈이 없어 /broker 기능이 비활성화되어 있습니다 (stub).";
}

export function startBrokerPolling(..._args: any[]): void {}

export function stopBrokerPolling(_code?: any): void {}

export function isBrokerPolling(_code?: any): boolean {
  return false;
}

export function listBrokerPolling(): string[] {
  return [];
}
