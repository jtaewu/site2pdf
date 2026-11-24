// CLI 실행기: Node 버전을 먼저 확인한 뒤 TypeScript 진입점을 불러온다 (Node 24의 type stripping 사용)
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  process.stderr.write(`site2pdf는 Node.js 24 이상이 필요합니다 (현재 ${process.version}). https://nodejs.org 에서 LTS를 설치하세요.\n`);
  process.exit(2);
}
await import('../src/cli/bin.ts');
