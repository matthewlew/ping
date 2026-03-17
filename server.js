import express from 'express';
import webpush from 'web-push';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ─── VAPID ────────────────────────────────────────────────────────────────────
// Generate once: npx web-push generate-vapid-keys
// Set env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, BASE_URL
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'YOUR_VAPID_PUBLIC_KEY';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'YOUR_VAPID_PRIVATE_KEY';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     || 'mailto:you@example.com';
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

// ─── IN-MEMORY STORE ──────────────────────────────────────────────────────────
// Swap Maps for Supabase tables when ready — schema is 1:1
const db = {
  users:       new Map(), // id → User
  friendships: new Map(), // `${a}:${b}` → Friendship
  invites:     new Map(), // token → Invite
  calls:       new Map(), // id → Call
};

// Seed one demo user so the main app isn't empty on first load
const DEMO_ID = 'user-demo-a';
db.users.set(DEMO_ID, mkUser(DEMO_ID, 'You', 'America/New_York', '🌊', 'blob'));

function mkUser(id, name, timezone, avatar = '👋', avatarShape = 'circle') {
  return {
    id, name, timezone, avatar, avatarShape,
    schedule: defaultSchedule(),
    bestTimes: [],           // morning | afternoon | evening | night
    pushSub: null,
    lastSeen: Date.now(),
    createdAt: Date.now(),
  };
}

function defaultSchedule() {
  return ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].reduce((acc, d) => {
    acc[d] = { available: true, start: '08:00', end: '23:00' };
    return acc;
  }, {});
}

function friendKey(a, b) { return [a, b].sort().join(':'); }

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────
function localHour(tz) {
  try {
    return parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false,
    }).format(new Date()), 10);
  } catch { return 12; }
}

function localTimeLabel(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());
  } catch { return '--:--'; }
}

function statusPill(tz) {
  const h = localHour(tz);
  if (h >= 0  && h < 8)  return 'asleep';
  if (h >= 8  && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

function isQuietHours(user) {
  // Use user's schedule if available, otherwise midnight–8am
  const h = localHour(user.timezone);
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];
  const sched = user.schedule?.[day];
  if (!sched || !sched.available) return true;
  // Parse start/end HH:MM
  const toH = t => { const [hh,mm] = (t||'').split(':').map(Number); return hh + (mm||0)/60; };
  const wake  = toH(sched.start || '08:00');
  const sleep = toH(sched.end   || '23:00');
  if (sleep > wake) return h < wake || h >= sleep;
  return h >= sleep && h < wake; // wraps midnight
}

// ─── PUSH HELPER ──────────────────────────────────────────────────────────────
async function sendPush(userId, payload) {
  const user = db.users.get(userId);
  if (!user?.pushSub) return { ok: false, reason: 'no-sub' };
  try {
    await webpush.sendNotification(user.pushSub, JSON.stringify(payload));
    return { ok: true };
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      user.pushSub = null;
      // mark invalid in friendships
      db.friendships.forEach(f => {
        if (f.userA === userId) f.pushValidA = false;
        if (f.userB === userId) f.pushValidB = false;
      });
    }
    return { ok: false, reason: e.message };
  }
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Config
app.get('/api/vapid-public-key', (_req, res) => res.json({ key: VAPID_PUBLIC }));

// Heartbeat — keeps lastSeen fresh; drives the "app installed" heuristic
app.post('/api/heartbeat', (req, res) => {
  let user = db.users.get(req.body.userId);
  if (!user) {
    user = mkUser(req.body.userId, 'You', 'America/New_York');
    db.users.set(req.body.userId, user);
  }
  user.lastSeen = Date.now();
  res.json({ ok: true });
});

// Push subscription
app.post('/api/push/subscribe', (req, res) => {
  let user = db.users.get(req.body.userId);
  if (!user) {
    user = mkUser(req.body.userId, 'You', 'America/New_York');
    db.users.set(req.body.userId, user);
  }
  user.pushSub  = req.body.subscription;
  user.lastSeen = Date.now();
  db.friendships.forEach(f => {
    if (f.userA === req.body.userId) f.pushValidA = true;
    if (f.userB === req.body.userId) f.pushValidB = true;
  });
  res.json({ ok: true });
});

// Update profile (name, timezone, schedule, bestTimes)
app.patch('/api/users/:userId', (req, res) => {
  let user = db.users.get(req.params.userId);
  if (!user) {
    // Auto-create if missing (e.g. server restart)
    user = mkUser(req.params.userId, 'You', 'America/New_York');
    db.users.set(req.params.userId, user);
  }
  const { name, timezone, schedule, bestTimes, avatar, avatarShape } = req.body;
  if (name)        user.name        = String(name).slice(0, 32);
  if (timezone)    user.timezone    = String(timezone);
  if (schedule)    user.schedule    = schedule;
  if (bestTimes)   user.bestTimes   = bestTimes;
  if (avatar)      user.avatar      = avatar;
  if (avatarShape) user.avatarShape = avatarShape;
  res.json({ ok: true, user });
});

// Full account deletion
app.delete('/api/users/:userId', (req, res) => {
  const { userId } = req.params;
  if (!db.users.has(userId)) return res.status(404).json({ error: 'not found' });
  db.users.delete(userId);
  db.friendships.forEach((_, k) => { if (k.includes(userId)) db.friendships.delete(k); });
  db.invites.forEach(inv => { if (inv.senderId === userId && !inv.usedAt) inv.expiresAt = Date.now(); });
  db.calls.forEach(c => { if ((c.fromId === userId || c.toId === userId) && c.status === 'pending') c.status = 'expired'; });
  res.json({ ok: true });
});

// ── INVITES ───────────────────────────────────────────────────────────────────
app.post('/api/invites/create', (req, res) => {
  let sender = db.users.get(req.body.senderId);
  if (!sender) {
    // Auto-create if missing (e.g. server restart)
    sender = mkUser(req.body.senderId, 'You', 'America/New_York');
    db.users.set(req.body.senderId, sender);
  }
  const token     = randomUUID().replace(/-/g, '').slice(0, 16);
  const expiresAt = Date.now() + 48 * 3600 * 1000;
  db.invites.set(token, { token, senderId: sender.id, expiresAt, usedAt: null, usedBy: null });
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ token, url: `${base}/invite/${token}`, expiresAt });
});

app.get('/api/invites/:token', (req, res) => {
  const inv = db.invites.get(req.params.token);
  if (!inv)         return res.status(404).json({ error: 'not found' });
  if (inv.usedAt)   return res.status(410).json({ error: 'used' });
  if (Date.now() > inv.expiresAt) return res.status(410).json({ error: 'expired' });
  const sender = db.users.get(inv.senderId);
  if (!sender) return res.status(404).json({ error: 'sender gone' });
  res.json({
    token: inv.token,
    sender: { id: sender.id, name: sender.name, timezone: sender.timezone, avatar: sender.avatar },
    senderSchedule: sender.schedule,
    expiresAt: inv.expiresAt,
  });
});

app.post('/api/invites/:token/accept', async (req, res) => {
  const inv = db.invites.get(req.params.token);
  if (!inv)         return res.status(404).json({ error: 'not found' });
  if (inv.usedAt)   return res.status(410).json({ error: 'used' });
  if (Date.now() > inv.expiresAt) return res.status(410).json({ error: 'expired' });

  const { name, timezone, schedule, bestTimes } = req.body;
  let { recipientId } = req.body;

  if (!recipientId || !db.users.has(recipientId)) {
    recipientId = `user-${randomUUID().slice(0, 8)}`;
    db.users.set(recipientId, mkUser(recipientId, name || 'Friend', timezone || 'UTC'));
  }
  const recip = db.users.get(recipientId);
  if (name)      recip.name      = String(name).slice(0, 32);
  if (timezone)  recip.timezone  = timezone;
  if (schedule)  recip.schedule  = schedule;
  if (bestTimes) recip.bestTimes = bestTimes;
  recip.lastSeen = Date.now();

  if (recipientId === inv.senderId) return res.status(400).json({ error: 'cannot add yourself' });

  inv.usedAt = Date.now();
  inv.usedBy = recipientId;

  const key = friendKey(inv.senderId, recipientId);
  if (!db.friendships.has(key)) {
    const [a, b] = key.split(':');
    db.friendships.set(key, {
      userA: a, userB: b, since: Date.now(), lastCall: null,
      pushValidA: !!db.users.get(a)?.pushSub,
      pushValidB: !!db.users.get(b)?.pushSub,
    });
  }

  // Notify sender
  await sendPush(inv.senderId, {
    type: 'invite-accepted',
    title: `${recip.name} joined ping`,
    body: 'Tap to see their card.',
    data: { friendId: recipientId },
  });

  res.json({
    ok: true,
    userId: recipientId,
    user: db.users.get(recipientId),
    friend: db.users.get(inv.senderId),
  });
});

// ── FRIENDS ───────────────────────────────────────────────────────────────────
app.get('/api/friends/:userId', (req, res) => {
  const { userId } = req.params;
  if (!db.users.has(userId)) {
    db.users.set(userId, mkUser(userId, 'You', 'America/New_York'));
  }

  const friends = [];
  db.friendships.forEach((f, key) => {
    if (!key.includes(userId)) return;
    const friendId = f.userA === userId ? f.userB : f.userA;
    const friend   = db.users.get(friendId);
    if (!friend) return;
    const pushValid     = f.userA === userId ? f.pushValidB : f.pushValidA;
    const heartbeatDays = Math.floor((Date.now() - friend.lastSeen) / 86400000);
    const daysSinceLast = f.lastCall ? Math.floor((Date.now() - f.lastCall) / 86400000) : null;

    friends.push({
      id: friend.id,
      name: friend.name,
      avatar: friend.avatar,
      avatarShape: friend.avatarShape,
      timezone: friend.timezone,
      localTime: localTimeLabel(friend.timezone),
      status: statusPill(friend.timezone),
      isQuiet: isQuietHours(friend),
      bestTimes: friend.bestTimes || [],
      schedule: friend.schedule,
      pushValid,
      appInstalled: heartbeatDays < 7 && !!friend.pushSub,
      heartbeatDays,
      daysSinceLastCall: daysSinceLast,
      since: f.since,
    });
  });

  res.json({ friends });
});

// ── CALLS ─────────────────────────────────────────────────────────────────────
app.post('/api/calls/ping', async (req, res) => {
  const { fromId, toId } = req.body;
  const from = db.users.get(fromId);
  const to   = db.users.get(toId);
  if (!from || !to) return res.status(404).json({ error: 'user not found' });

  if (isQuietHours(to)) {
    return res.status(403).json({
      error: 'quiet-hours',
      message: `It's ${localTimeLabel(to.timezone)} for ${to.name} — ping held until they're up.`,
      localTime: localTimeLabel(to.timezone),
    });
  }

  const callId = randomUUID();
  db.calls.set(callId, {
    id: callId, fromId, toId,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600 * 1000,
    deliveredAt: null, respondedAt: null,
  });

  const result = await sendPush(toId, {
    type: 'incoming-ping',
    title: `${from.name} wants to call`,
    body: "Tap yes when you're free.",
    data: { callId, fromId, fromName: from.name },
    actions: [
      { action: 'yes',    title: '✓ Yes' },
      { action: 'yes-30', title: '⏱ In 30 min' },
      { action: 'no',     title: '✗ Not now' },
    ],
  });

  if (result.ok) db.calls.get(callId).deliveredAt = Date.now();

  res.json({
    callId,
    delivered: result.ok,
    reason: result.reason,
    message: result.ok
      ? `Ping sent to ${to.name} (${localTimeLabel(to.timezone)} their time)`
      : `Ping queued — push may not reach ${to.name} right now`,
  });
});

app.post('/api/calls/:callId/respond', async (req, res) => {
  const call = db.calls.get(req.params.callId);
  if (!call)                   return res.status(404).json({ error: 'not found' });
  if (call.status !== 'pending') return res.status(409).json({ error: 'already responded' });
  if (Date.now() > call.expiresAt) return res.status(410).json({ error: 'expired' });

  const { action, userId } = req.body;
  call.status      = action === 'no' ? 'declined' : action === 'yes-30' ? 'deferred' : 'accepted';
  call.respondedAt = Date.now();

  const key = friendKey(call.fromId, call.toId);
  if (db.friendships.has(key)) db.friendships.get(key).lastCall = Date.now();

  const responder = db.users.get(userId);
  const from      = db.users.get(call.fromId);
  const msgs      = {
    accepted: `${responder?.name || 'They'}'re free — call now!`,
    declined: `${responder?.name || 'They'} can't talk right now.`,
    deferred: `${responder?.name || 'They'}'ll be free in 30 min.`,
  };

  if (!isQuietHours(from)) {
    await sendPush(call.fromId, {
      type: 'call-response',
      title: msgs[call.status],
      body: call.status === 'accepted' ? 'Open the app to connect.' : '',
      data: { callId: call.id, response: call.status },
    });
  }

  res.json({ ok: true, status: call.status });
});

app.get('/api/calls/:callId', (req, res) => {
  const call = db.calls.get(req.params.callId);
  if (!call) return res.status(404).json({ error: 'not found' });
  res.json(call);
});

// ─── PAGE ROUTES ──────────────────────────────────────────────────────────────
app.get(/^\/invite\/.*/, (_req, res) => res.sendFile(join(__dirname, 'public', 'invite.html')));
app.get('/onboarding.html', (_req, res) => res.sendFile(join(__dirname, 'public', 'onboarding.html')));
app.get(/.*/, (_req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ping → http://localhost:${PORT}`));
