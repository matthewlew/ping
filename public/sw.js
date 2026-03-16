// ping service worker v2
// Handles: offline cache, push notifications, background yes/no/yes-30 responses

const CACHE = 'ping-v2';
const STATIC = ['/', '/index.html', '/invite.html', '/onboarding.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Offline-first for static assets; bypass for API
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { caches.open(CACHE).then(c => c.put(e.request, res.clone())); return res; })
      .catch(() => caches.match(e.request))
  );
});

// Push received
self.addEventListener('push', e => {
  if (!e.data) return;
  const p = e.data.json();
  e.waitUntil(self.registration.showNotification(p.title, {
    body:               p.body,
    data:               p.data,
    icon:               '/icon-192.png',
    badge:              '/badge.png',
    tag:                p.data?.callId || p.type,
    requireInteraction: p.type === 'incoming-ping',
    actions:            p.actions || [],
  }));
});

// Notification tapped or action button pressed
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data   = e.notification.data || {};
  const action = e.action;

  if (!action) {
    // Body tap — focus or open app
    e.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
        const existing = cs.find(c => c.url.includes(self.registration.scope));
        if (existing) return existing.focus();
        return clients.openWindow('/');
      })
    );
    return;
  }

  if (data.callId && ['yes', 'yes-30', 'no'].includes(action)) {
    e.waitUntil(respondToCall(data.callId, action, data));
  }
});

async function respondToCall(callId, action, data) {
  const userId = await getItem('userId');
  try {
    await fetch(`/api/calls/${callId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, userId }),
    });
  } catch (e) { console.error('SW respond error:', e); }

  // Relay to open app windows
  const cs = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  cs.forEach(c => c.postMessage({
    type: 'call-response',
    data: { callId, response: action, friendName: data.fromName },
  }));
}

// IDB helpers (localStorage not available in SW)
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ping-sw', 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    r.onsuccess = e => res(e.target.result);
    r.onerror   = rej;
  });
}

async function getItem(key) {
  try {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const r  = tx.objectStore('kv').get(key);
      r.onsuccess = e => res(e.target.result || null);
      r.onerror   = rej;
    });
  } catch { return null; }
}

async function setItem(key, val) {
  try {
    const db = await openDB();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
  } catch {}
}

// Main thread sets userId after push subscription
self.addEventListener('message', e => {
  if (e.data?.type === 'set-user-id') setItem('userId', e.data.userId);
});
