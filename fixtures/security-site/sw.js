self.addEventListener('install', () => { fetch('__SENTINEL__/sw-install').catch(() => {}); self.skipWaiting(); });
self.addEventListener('activate', () => { fetch('__SENTINEL__/sw-activate').catch(() => {}); });
