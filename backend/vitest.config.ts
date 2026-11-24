import { defineConfig } from 'vitest/config';

// 실행은 npm test(scripts/vitest.mjs 경유)로 한다: Windows 드라이브 문자 대소문자 문제 회피
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 브라우저 E2E는 무겁기 때문에 파일 단위 병렬 실행을 제한한다
    fileParallelism: false,
  },
});
