import { chromium, type Browser } from 'playwright';

export type LaunchOptions = {
  /** 이그레스 프록시 주소 (필수: 모든 브라우저 트래픽은 프록시를 거친다) */
  proxyUrl: string;
  /**
   * 개발 편의용 시스템 브라우저 채널(chrome|msedge). 기본은 Playwright 전용 Chromium (ADR-001).
   * 조직 정책으로 확장이 강제 설치된 브라우저는 --disable-extensions 를 주면 시작하지 못하므로 그 인자만 뺀다.
   */
  channel?: 'chrome' | 'msedge';
};

export async function launchBrowser(opts: LaunchOptions): Promise<Browser> {
  return chromium.launch({
    headless: true,
    channel: opts.channel,
    ignoreDefaultArgs: opts.channel ? ['--disable-extensions'] : undefined,
    args: [
      `--proxy-server=${opts.proxyUrl}`,
      // 기본값은 루프백을 프록시 없이 직접 연결한다(PoC S5). <-loopback> 으로 루프백도 프록시를 거치게 한다
      '--proxy-bypass-list=<-loopback>',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-sync',
      '--no-pings',
      '--dns-prefetch-disable',
    ],
  });
}
