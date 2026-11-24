import { z } from 'zod';

// 기본값은 Phase 0 결정 D-03(제한값), D-06(쿼리), D-08(사이트별 렌더 설정), D-09(외부 리소스)를 따른다.
export const crawlSchema = z
  .object({
    maxPages: z.number().int().min(1).max(5000).default(200),
    maxDepth: z.number().int().min(0).max(20).default(5),
    minDelayMs: z.number().int().min(0).max(60_000).default(1000),
    timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
    maxTotalMs: z.number().int().min(1000).max(6 * 3600_000).default(600_000),
    /** MVP는 동시성 1 고정 (공격적 병렬 수집 금지) */
    concurrency: z.literal(1).default(1),
    respectRobotsTxt: z.boolean().default(true),
    /** 일시적 실패(시간 초과·502/503/504 등) 재시도 횟수. 보안 차단·접근 거부는 재시도하지 않음 */
    retries: z.number().int().min(0).max(3).default(1),
    query: z
      .object({
        policy: z.enum(['drop', 'keep']).default('drop'),
        keepParams: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ policy: 'drop', keepParams: [] }),
  })
  .strict();

export const scopeSchema = z
  .object({
    allowedOrigins: z.array(z.string()).default([]),
    pathPrefixes: z.array(z.string().startsWith('/')).min(1).default(['/']),
    denyPatterns: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const renderSchema = z
  .object({
    /** 이 선택자가 나타나야 렌더 완료로 본다 */
    readySelector: z.string().min(1).optional(),
    /** 본문 영역. 지정 시 이 요소가 없으면 실패, 본문 길이도 이 요소 기준. 인쇄도 이 영역만 */
    contentSelector: z.string().min(1).optional(),
    /** 인쇄 시 숨길 요소 */
    hideSelectors: z.array(z.string().min(1)).default([]),
    /** 본문 텍스트가 이보다 짧으면 렌더 실패로 판정 (D-14) */
    minTextLength: z.number().int().min(0).default(20),
    /** DOM 변경이 이 시간 동안 없으면 안정 상태로 본다 */
    quietMs: z.number().int().min(100).max(10_000).default(500),
  })
  .strict();

export const selectionSchema = z
  .object({
    /** 경로 glob (예: /docs/**). 비어 있으면 범위 안 전체 포함 */
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    /** 통합 PDF에서 앞에 둘 페이지 경로(pathname+search)의 순서. 나머지는 발견 순서 (SC-04) */
    order: z.array(z.string().startsWith('/')).default([]),
  })
  .strict();

export const pdfSchema = z
  .object({
    pageSize: z.enum(['A4', 'A3', 'Letter', 'Legal']).default('A4'),
    /** 페이지 여백(mm) */
    marginMm: z.number().min(0).max(50).default(14),
    printBackground: z.boolean().default(true),
    /** 페이지별 PDF 생성 (FR-06) */
    pagewise: z.boolean().default(true),
    /** 통합 PDF 생성 (FR-07) */
    combined: z.boolean().default(true),
    /** 통합 PDF 제목 메타데이터 (FR-13). 없으면 시작 페이지 제목 */
    title: z.string().min(1).max(200).optional(),
    /** 통합 PDF 파일 이름(확장자 제외, FR-13) */
    fileName: z.string().min(1).max(80).default('site-combined'),
    /** 그룹별 PDF (FR-11, SC-05): 경로 prefix(세그먼트 경계)에 해당하는 페이지만 모은 추가 PDF */
    groups: z
      .array(
        z
          .object({
            name: z.string().min(1).max(60),
            title: z.string().min(1).max(200).optional(),
            pathPrefixes: z.array(z.string().startsWith('/')).min(1),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict();

const common = {
  scope: scopeSchema.default({ allowedOrigins: [], pathPrefixes: ['/'], denyPatterns: [] }),
  crawl: crawlSchema.default(crawlSchema.parse({})),
  render: renderSchema.default(renderSchema.parse({})),
  selection: selectionSchema.default({ include: [], exclude: [], order: [] }),
  pdf: pdfSchema.default(pdfSchema.parse({})),
};

export const remoteConfigSchema = z
  .object({
    mode: z.literal('remote'),
    startUrl: z.string(),
    /** 하위 리소스(CDN·웹폰트 등)로 추가 허용할 https origin (D-09, 보안 검토 후 지정) */
    resources: z.object({ allowedOrigins: z.array(z.string()).default([]) }).strict().default({ allowedOrigins: [] }),
    ...common,
  })
  .strict();

export const localConfigSchema = z
  .object({
    mode: z.literal('local'),
    sourcePath: z.string().min(1),
    /** 로컬 사이트에서 시작할 경로 */
    startPath: z.string().startsWith('/').default('/'),
    /** SPA History 라우팅 빌드: 이 prefix 아래 없는 경로는 index.html로 응답 */
    spaFallbackPrefix: z.string().startsWith('/').optional(),
    ...common,
  })
  .strict();

export const configSchema = z.discriminatedUnion('mode', [remoteConfigSchema, localConfigSchema]);

export type Config = z.infer<typeof configSchema>;
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export type LocalConfig = z.infer<typeof localConfigSchema>;
export type CrawlConfig = z.infer<typeof crawlSchema>;
export type RenderConfig = z.infer<typeof renderSchema>;
export type SelectionConfig = z.infer<typeof selectionSchema>;
export type PdfConfig = z.infer<typeof pdfSchema>;
