import express from 'express';
import webpush from 'web-push';
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { Redis } from '@upstash/redis';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

// ─── REDIS / PERSISTENCE ──────────────────────────────────────────────────────
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
const INVITE_SECRET = process.env.INVITE_SECRET || 'dev_secret_key';

// Helper to interact with Redis as if it were a Map
const db = {
  users: {
    get: async (id) => await redis.hget('users', id),
    set: async (id, val) => await redis.hset('users', { [id]: val }),
    delete: async (id) => await redis.hdel('users', id),
    all: async () => await redis.hgetall('users') || {},
  },
  friendships: {
    get: async (key) => await redis.hget('friendships', key),
    set: async (key, val) => await redis.hset('friendships', { [key]: val }),
    delete: async (key) => await redis.hdel('friendships', key),
    all: async () => await redis.hgetall('friendships') || {},
  },
  invitesUsed: {
    isUsed: async (token) => await redis.sismember('used_invites', token),
    markUsed: async (token) => await redis.sadd('used_invites', token),
  },
  calls: {
    get: async (id) => await redis.hget('calls', id),
    set: async (id, val) => await redis.hset('calls', { [id]: val }),
  }
};

// ─── VAPID ────────────────────────────────────────────────────────────────────
// Generate once: npx web-push generate-vapid-keys
// Set env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, BASE_URL
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:you@example.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    console.log('✓ VAPID keys initialized');
  } catch (err) {
    console.error('✗ Failed to set VAPID details:', err.message);
  }
} else {
  console.warn('⚠ VAPID keys missing. Push notifications will not work.');
}

// ─── IN-MEMORY STORE (DEPRECATED - NOW USING REDIS) ──────────────────────────

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
  const user = await db.users.get(userId);
  if (!user?.pushSub) return { ok: false, reason: 'no-sub' };
  try {
    await webpush.sendNotification(user.pushSub, JSON.stringify(payload));
    return { ok: true };
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      user.pushSub = null;
      await db.users.set(userId, user);
      // mark invalid in friendships
      const allFriends = await db.friendships.all();
      for (const [key, f] of Object.entries(allFriends)) {
        if (f.userA === userId) { f.pushValidA = false; await db.friendships.set(key, f); }
        if (f.userB === userId) { f.pushValidB = false; await db.friendships.set(key, f); }
      }
    }
    return { ok: false, reason: e.message };
  }
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), env: process.env.NODE_ENV, vercel: !!process.env.VERCEL });
});

// Config
app.get('/api/vapid-public-key', (_req, res) => res.json({ key: VAPID_PUBLIC }));

// Heartbeat — keeps lastSeen fresh; drives the "app installed" heuristic
app.post('/api/heartbeat', async (req, res) => {
  let user = await db.users.get(req.body.userId);
  if (!user) {
    user = mkUser(req.body.userId, 'You', 'America/New_York');
  }
  user.lastSeen = Date.now();
  await db.users.set(req.body.userId, user);
  res.json({ ok: true });
});

// Push subscription
app.post('/api/push/subscribe', async (req, res) => {
  let user = await db.users.get(req.body.userId);
  if (!user) {
    user = mkUser(req.body.userId, 'You', 'America/New_York');
  }
  user.pushSub  = req.body.subscription;
  user.lastSeen = Date.now();
  await db.users.set(req.body.userId, user);

  const allFriends = await db.friendships.all();
  for (const [key, f] of Object.entries(allFriends)) {
    if (f.userA === req.body.userId) { f.pushValidA = true; await db.friendships.set(key, f); }
    if (f.userB === req.body.userId) { f.pushValidB = true; await db.friendships.set(key, f); }
  }
  res.json({ ok: true });
});

// Update profile (name, timezone, schedule, bestTimes)
app.patch('/api/users/:userId', async (req, res) => {
  let user = await db.users.get(req.params.userId);
  if (!user) {
    // Auto-create if missing (e.g. server restart)
    user = mkUser(req.params.userId, 'You', 'America/New_York');
  }
  const { name, timezone, schedule, bestTimes, avatar, avatarShape } = req.body;
  if (name)        user.name        = String(name).slice(0, 32);
  if (timezone)    user.timezone    = String(timezone);
  if (schedule)    user.schedule    = schedule;
  if (bestTimes)   user.bestTimes   = bestTimes;
  if (avatar)      user.avatar      = avatar;
  if (avatarShape) user.avatarShape = avatarShape;
  await db.users.set(req.params.userId, user);
  res.json({ ok: true, user });
});

// Full account deletion
app.delete('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const user = await db.users.get(userId);
  if (!user) return res.status(404).json({ error: 'not found' });
  
  await db.users.delete(userId);
  const allFriends = await db.friendships.all();
  for (const [key, f] of Object.entries(allFriends)) {
    if (key.includes(userId)) await db.friendships.delete(key);
  }
  res.json({ ok: true });
});

// ── INVITES ───────────────────────────────────────────────────────────────────
app.post('/api/invites/create', async (req, res) => {
  let sender = await db.users.get(req.body.senderId);
  if (!sender) {
    // Auto-create if missing (e.g. server restart)
    sender = mkUser(req.body.senderId, 'You', 'America/New_York');
    await db.users.set(req.body.senderId, sender);
  }
  
  // Create a signed token containing the senderId and expiration
  const token = jwt.sign(
    { senderId: sender.id, exp: Math.floor(Date.now() / 1000) + (48 * 3600) },
    INVITE_SECRET
  );
  
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host  = req.get('x-forwarded-host') || req.get('host');
  const base  = process.env.BASE_URL || `${proto}://${host}`;
  res.json({ token, url: `${base}/invite/${token}`, expiresAt: Date.now() + 48 * 3600 * 1000 });
});

app.get('/api/invites/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, INVITE_SECRET);
    const isUsed = await db.invitesUsed.isUsed(req.params.token);
    if (isUsed) return res.status(410).json({ error: 'used' });

    const sender = await db.users.get(payload.senderId);
    if (!sender) return res.status(404).json({ error: 'sender gone' });

    res.json({
      token: req.params.token,
      sender: { id: sender.id, name: sender.name, timezone: sender.timezone, avatar: sender.avatar },
      senderSchedule: sender.schedule,
      expiresAt: payload.exp * 1000,
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(410).json({ error: 'expired' });
    return res.status(400).json({ error: 'invalid' });
  }
});

app.post('/api/invites/:token/accept', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, INVITE_SECRET);
    const isUsed = await db.invitesUsed.isUsed(req.params.token);
    if (isUsed) return res.status(410).json({ error: 'used' });

    const { name, timezone, schedule, bestTimes } = req.body;
    let { recipientId } = req.body;

    if (!recipientId || !(await db.users.get(recipientId))) {
      recipientId = `user-${randomUUID().slice(0, 8)}`;
      await db.users.set(recipientId, mkUser(recipientId, name || 'Friend', timezone || 'UTC'));
    }
    const recip = await db.users.get(recipientId);
    if (name)      recip.name      = String(name).slice(0, 32);
    if (timezone)  recip.timezone  = timezone;
    if (schedule)  recip.schedule  = schedule;
    if (bestTimes) recip.bestTimes = bestTimes;
    recip.lastSeen = Date.now();
    await db.users.set(recipientId, recip);

    if (recipientId === payload.senderId) return res.status(400).json({ error: 'cannot add yourself' });

    await db.invitesUsed.markUsed(req.params.token);

    const key = friendKey(payload.senderId, recipientId);
    let friendship = await db.friendships.get(key);
    if (!friendship) {
      const [a, b] = key.split(':');
      const sender = await db.users.get(a);
      const recipient = await db.users.get(b);
      friendship = {
        userA: a, userB: b, since: Date.now(), lastCall: null,
        pushValidA: !!sender?.pushSub,
        pushValidB: !!recipient?.pushSub,
      };
      await db.friendships.set(key, friendship);
    }

    // Notify sender
    await sendPush(payload.senderId, {
      type: 'invite-accepted',
      title: `${recip.name} joined ping`,
      body: 'Tap to see their card.',
      data: { friendId: recipientId },
    });

    res.json({
      ok: true,
      userId: recipientId,
      user: recip,
      friend: await db.users.get(payload.senderId),
    });
  } catch (err) {
    return res.status(400).json({ error: 'invalid' });
  }
});

// ── FRIENDS ───────────────────────────────────────────────────────────────────
app.get('/api/friends/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!(await db.users.get(userId))) {
    await db.users.set(userId, mkUser(userId, 'You', 'America/New_York'));
  }

  const allFriends = await db.friendships.all();
  const friends = [];
  for (const [key, f] of Object.entries(allFriends)) {
    if (!key.includes(userId)) continue;
    const friendId = f.userA === userId ? f.userB : f.userA;
    const friend   = await db.users.get(friendId);
    if (!friend) continue;
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
  }

  res.json({ friends });
});

// ── CALLS ─────────────────────────────────────────────────────────────────────
app.post('/api/calls/ping', async (req, res) => {
  const { fromId, toId } = req.body;
  const from = await db.users.get(fromId);
  const to   = await db.users.get(toId);
  if (!from || !to) return res.status(404).json({ error: 'user not found' });

  if (isQuietHours(to)) {
    return res.status(403).json({
      error: 'quiet-hours',
      message: `It's ${localTimeLabel(to.timezone)} for ${to.name} — ping held until they're up.`,
      localTime: localTimeLabel(to.timezone),
    });
  }

  const callId = randomUUID();
  const call = {
    id: callId, fromId, toId,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600 * 1000,
    deliveredAt: null, respondedAt: null,
  };
  await db.calls.set(callId, call);

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

  if (result.ok) {
    call.deliveredAt = Date.now();
    await db.calls.set(callId, call);
  }

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
  const call = await db.calls.get(req.params.callId);
  if (!call)                   return res.status(404).json({ error: 'not found' });
  if (call.status !== 'pending') return res.status(409).json({ error: 'already responded' });
  if (Date.now() > call.expiresAt) return res.status(410).json({ error: 'expired' });

  const { action, userId } = req.body;
  call.status      = action === 'no' ? 'declined' : action === 'yes-30' ? 'deferred' : 'accepted';
  call.respondedAt = Date.now();
  await db.calls.set(req.params.callId, call);

  const key = friendKey(call.fromId, call.toId);
  const friendship = await db.friendships.get(key);
  if (friendship) {
    friendship.lastCall = Date.now();
    await db.friendships.set(key, friendship);
  }

  const responder = await db.users.get(userId);
  const from      = await db.users.get(call.fromId);
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

app.get('/api/calls/:callId', async (req, res) => {
  const call = await db.calls.get(req.params.callId);
  if (!call) return res.status(404).json({ error: 'not found' });
  res.json(call);
});

// ─── PAGE ROUTES ──────────────────────────────────────────────────────────────
app.get(/^\/invite\/.*/, (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'invite.html')));
app.get('/onboarding.html', (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'onboarding.html')));
app.get(/.*/, (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`ping → http://localhost:${PORT}`));
}

export default app;
