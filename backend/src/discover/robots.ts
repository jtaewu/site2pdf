// robots.txt 판정 (FR-04, T-08). 원격 모드 전용.
// 기본 정책(06-technical-design §1): 확인 실패·금지면 수집 중지. 404/410은 "robots 없음"으로 보고 허용.
import robotsParserModule from 'robots-parser';

// robots-parser는 CJS(module.exports = 함수)인데 타입은 ESM default로 선언되어 있어 런타임 형태에 맞춰 캐스팅한다
const robotsParser = robotsParserModule as unknown as typeof robotsParserModule.default;

export const USER_AGENT_TOKEN = 'site2pdf';

export type RobotsFetch = (url: string) => Promise<{ status: number; body: string } | { error: string }>;

export type RobotsPolicy =
  | { state: 'not-applicable' }
  | { state: 'absent'; status: number }
  | { state: 'present'; isAllowed(url: string): boolean; crawlDelaySec?: number }
  | { state: 'unavailable'; reason: string };

export async function loadRobots(origin: string, fetchText: RobotsFetch): Promise<RobotsPolicy> {
  const robotsUrl = `${origin}/robots.txt`;
  const r = await fetchText(robotsUrl);
  if ('error' in r) return { state: 'unavailable', reason: r.error };
  if (r.status === 404 || r.status === 410) return { state: 'absent', status: r.status };
  if (r.status !== 200) return { state: 'unavailable', reason: `http-${r.status}` };
  const parser = robotsParser(robotsUrl, r.body);
  return {
    state: 'present',
    // 판정 불가(undefined)는 허용으로 본다: robots-parser는 다른 origin URL에만 undefined를 돌려준다
    isAllowed: (url) => parser.isAllowed(url, USER_AGENT_TOKEN) !== false,
    crawlDelaySec: parser.getCrawlDelay(USER_AGENT_TOKEN),
  };
}
