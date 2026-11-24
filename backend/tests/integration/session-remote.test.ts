// 원격 모드 세션 사전 검사: 시작 호스트가 비공개 주소로 해석되면 브라우저를 띄우기 전에 거부 (T-03, SC-08)
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.ts';
import { openSession } from '../../src/session.ts';
import { Site2pdfError } from '../../src/errors.ts';

const remote = configSchema.parse({ mode: 'remote', startUrl: 'https://docs.example.com/guide', scope: { allowedOrigins: ['https://docs.example.com'] } });

describe('원격 세션 사전 검사', () => {
  it.each([['127.0.0.1'], ['169.254.169.254'], ['10.0.0.8'], ['fd00::5']])('시작 호스트가 %s 로 해석되면 보안 오류(4)', async (addr) => {
    const err = await openSession(remote, { resolver: async () => ['93.184.216.34', addr] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Site2pdfError);
    expect((err as Site2pdfError).exitCode).toBe(4);
    expect((err as Site2pdfError).code).toBe('start-host-non-public');
  });

  it('DNS 해석 실패는 입력 오류(2)', async () => {
    const err = await openSession(remote, { resolver: async () => { throw new Error('ENOTFOUND'); } }).catch((e: unknown) => e);
    expect((err as Site2pdfError).exitCode).toBe(2);
  });
});
