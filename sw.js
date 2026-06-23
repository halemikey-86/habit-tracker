const CACHE = 'habit-quest-v1';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/config.js',
  '/manifest.json',
  '/assets/Phase 1 Map.png',
  '/assets/MichaelChar.png',
  '/assets/Node Active.png',
  '/assets/Node Completed.png',
  '/assets/Node Alert.png',
  '/assets/icon.svg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Supabase API and Google Fonts: network only, no caching
  if (e.request.url.includes('supabase.co') ||
      e.request.url.includes('googleapis.com') ||
      e.request.url.includes('esm.sh')) return;

  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request))
  );
});
