// 실행 세션: 입력 모드에 맞춰 로컬 서버·이그레스 프록시·브라우저·안전 컨텍스트를 한 번에 구성하고 정리한다.
import type { Browser } from 'playwright';
import type { Config } from './config/schema.ts';
import { ExitCode, Site2pdfError } from './errors.ts';
import { startEgressProxy, systemResolver, type EgressProxy, type Resolver } from './fetch-policy/egress-proxy.ts';
import { nonPublicIpReason } from './fetch-policy/ip.ts';
import type { Scope } from './fetch-policy/url.ts';
import { startStaticServer, type StaticServer } from './local/static-server.ts';
import { launchBrowser } from './browser/launch.ts';
import { createSafeContext, type BlockedRequest } from './browser/context.ts';
import { createBrowserPageLoader, type PageLoader } from './browser/page-loader.ts';
import { loadRobots, type RobotsFetch, type RobotsPolicy } from './discover/robots.ts';
import { silentLogger, type Logger } from './report/logger.ts';

export type SessionOptions = {
  channel?: 'chrome' | 'msedge';
  /** 테스트 전용: DNS 해석기 교체 */
  resolver?: Resolver;
  log?: Logger;
};

export type Session = {
  startUrl: string;
  scope: Scope;
  /** 로컬 모드의 임시 서버 origin (원격이면 null) */
  localOrigin: string | null;
  load: PageLoader;
  fetchText: RobotsFetch;
  robots: RobotsPolicy;
  blocked: BlockedRequest[];
  egress: EgressProxy;
  close(): Promise<void>;
};

export async function openSession(config: Config, opts: SessionOptions = {}): Promise<Session> {
  const log = opts.log ?? silentLogger;
  const cleanups: Array<() => Promise<unknown>> = [];
  const close = async () => {
    for (const c of cleanups.reverse()) await c().catch(() => {});
  };
  try {
    let startUrl: string;
    let scope: Scope;
    let localServer: StaticServer | null = null;
    let egress: EgressProxy;
    let resourceOrigins: string[] = [];

    if (config.mode === 'local') {
      localServer = await startStaticServer(config.sourcePath, { spaFallbackPrefix: config.spaFallbackPrefix });
      cleanups.push(() => localServer!.close());
      const hostPort = new URL(localServer.origin).host;
      // 로컬 모드: 로컬 서버 외 모든 목적지 거부 (FR-12, T-17)
      egress = await startEgressProxy({ allowedHostPorts: [hostPort], privateExceptions: [hostPort], resolve: opts.resolver });
      startUrl = localServer.origin + config.startPath;
      scope = { ...config.scope, allowedOrigins: [localServer.origin] };
      log.info(`로컬 모드: ${config.sourcePath} → ${localServer.origin}`);
    } else {
      const resolver = opts.resolver ?? systemResolver;
      const host = new URL(config.startUrl).hostname;
      // 사전 확인은 안내용. 실제 강제는 프록시가 연결 시점에 다시 한다 (재바인딩 대비)
      let addresses: string[];
      try {
        addresses = await resolver(host);
      } catch {
        throw new Site2pdfError(ExitCode.INPUT, 'dns-failure', `시작 호스트를 해석할 수 없습니다: ${host}`);
      }
      const bad = addresses.find((a) => nonPublicIpReason(a));
      if (bad) throw new Site2pdfError(ExitCode.SECURITY, 'start-host-non-public', `시작 호스트가 비공개 주소로 해석됩니다: ${host} → ${bad}`);
      resourceOrigins = config.resources.allowedOrigins;
      const hostPorts = [config.scope.allowedOrigins[0]!, ...resourceOrigins].map((o) => {
        const u = new URL(o);
        return `${u.hostname}:${u.port || 443}`;
      });
      egress = await startEgressProxy({ allowedHostPorts: hostPorts, resolve: resolver });
      startUrl = config.startUrl;
      scope = config.scope;
    }
    cleanups.push(() => egress.close());

    let browser: Browser;
    try {
      browser = await launchBrowser({ proxyUrl: egress.url, channel: opts.channel });
    } catch (e) {
      throw new Site2pdfError(ExitCode.RUN, 'browser-launch-failed', `브라우저 실행 실패: ${(e as Error).message.split('\n')[0]} (npm run browser:install 로 Chromium 설치 필요)`);
    }
    cleanups.push(() => browser.close());
    const { context, blocked } = await createSafeContext(browser, { pageOrigins: scope.allowedOrigins, resourceOrigins });
    cleanups.push(() => context.close());

    const fetchText: RobotsFetch = async (url) => {
      const page = await context.newPage();
      try {
        const res = await page.goto(url, { timeout: config.crawl.timeoutMs });
        if (!res) return { error: 'no-response' };
        return { status: res.status(), body: res.status() === 200 ? await res.text() : '' };
      } catch (e) {
        return { error: (e as Error).message.split('\n')[0] ?? 'error' };
      } finally {
        await page.close().catch(() => {});
      }
    };

    let robots: RobotsPolicy = { state: 'not-applicable' };
    if (config.mode === 'remote' && config.crawl.respectRobotsTxt) robots = await loadRobots(scope.allowedOrigins[0]!, fetchText);

    return {
      startUrl,
      scope,
      localOrigin: localServer?.origin ?? null,
      load: createBrowserPageLoader(context, config.render, config.crawl.timeoutMs),
      fetchText,
      robots,
      blocked,
      egress,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
