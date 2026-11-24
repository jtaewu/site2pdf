// 클라이언트 라우팅 + 지연 렌더링 fixture. 서버는 /app/* 요청에 index.html을 반환한다.
const routes = {
  '/app/': { title: 'SPA 홈', body: '<h1>SPA 홈</h1><p>클라이언트에서 렌더링된 한글 본문입니다. 검색어: 동적렌더링확인</p>' },
  '/app/guide': { title: 'SPA 가이드', body: '<h1>SPA 가이드</h1><h2>단계 1</h2><p>설명</p><pre>const x = "코드 블록";</pre>' },
  '/app/api': { title: 'SPA API', body: '<h1>SPA API</h1><table border="1"><tr><th>필드</th><th>설명</th></tr><tr><td>amount</td><td>금액</td></tr></table>' },
  '/app/slow': { title: 'SPA 느린 페이지', body: null }, // 영원히 렌더링되지 않음 → 타임아웃 검증용
};
function render() {
  const r = routes[location.pathname] || { title: '404', body: '<h1>찾을 수 없음</h1>' };
  const root = document.getElementById('root');
  root.innerHTML = '로딩 중...';
  if (r.body === null) return; // slow: 끝까지 로딩 중
  setTimeout(() => {
    document.title = r.title + ' | SPA Fixture';
    root.innerHTML = `<nav>${Object.keys(routes).map(p => `<a href="${p}" data-link>${routes[p].title}</a>`).join('')}<a href="https://example.invalid/spa-external">외부</a></nav><main>${r.body}</main>`;
  }, 700);
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (a) { e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); render(); }
});
addEventListener('popstate', render);
render();
