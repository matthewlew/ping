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

// ─── REDIS ────────────────────────────────────────────────────────────────────
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
const INVITE_SECRET     = process.env.INVITE_SECRET || 'dev_secret_key';
const CALL_TTL_SEC      = 48 * 3600;   // 48 hours
const INVITE_TTL_SEC    = 48 * 3600;   // matches token expiry
const HEARTBEAT_SKIP_MS = 4 * 60 * 1000; // skip write if seen within 4 min

// ─── DB LAYER (per-user keys — O(1) lookups, no full-table scans) ─────────────
//
//  Key schema:
//    user:{id}            → user object (JSON)
//    friends:{userId}     → SET of friend IDs
//    friendship:{a:b}     → friendship object (JSON, IDs sorted)
//    call:{id}            → call object (JSON, 48h TTL)
//    invite_used:{token}  → '1' (48h TTL, NX-set for atomic race protection)
//    rl:{userId}:{ep}     → request count for sliding-window rate limit
//
const db = {
  users: {
    get:    (id)       => redis.get(`user:${id}`),
    set:    (id, val)  => redis.set(`user:${id}`, val),
    delete: (id)       => redis.del(`user:${id}`),
    // Batch-fetch multiple users in one Redis call
    mget:   (ids)      => ids.length
      ? redis.mget(...ids.map(id => `user:${id}`))
      : Promise.resolve([]),
  },
  friends: {
    list: (userId) => redis.smembers(`friends:${userId}`),
    add:  async (a, b) => Promise.all([
      redis.sadd(`friends:${a}`, b),
      redis.sadd(`friends:${b}`, a),
    ]),
    remove: async (a, b) => Promise.all([
      redis.srem(`friends:${a}`, b),
      redis.srem(`friends:${b}`, a),
    ]),
  },
  friendships: {
    get:    (key)      => redis.get(`friendship:${key}`),
    set:    (key, val) => redis.set(`friendship:${key}`, val),
    delete: (key)      => redis.del(`friendship:${key}`),
  },
  calls: {
    get: (id)      => redis.get(`call:${id}`),
    set: (id, val) => redis.set(`call:${id}`, val, { ex: CALL_TTL_SEC }),
  },
  history: {
    // Add a call to a user's history list. Max 50 items.
    add: async (userId, callId) => {
      await redis.lpush(`history:${userId}`, callId);
      await redis.ltrim(`history:${userId}`, 0, 49);
    },
    list: (userId) => redis.lrange(`history:${userId}`, 0, 49),
  },
  invitesUsed: {
    isUsed:   (token) => redis.exists(`invite_used:${token}`),
    // NX = only set if not exists → atomic: returns true if we claimed it first
    markUsed: async (token) => {
      const r = await redis.set(`invite_used:${token}`, '1', { ex: INVITE_TTL_SEC, nx: true });
      return r !== null;
    },
  },
};

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
// Fails open: if Redis errors, the request is allowed rather than blocking everyone.
async function checkRateLimit(userId, endpoint, limit, windowSec) {
  try {
    const key   = `rl:${userId}:${endpoint}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    return count <= limit;
  } catch {
    return true; // fail open
  }
}

function rateLimit(endpoint, limit, windowSec = 60) {
  return async (req, res, next) => {
    const userId = req.body?.userId || req.body?.fromId || req.body?.senderId;
    if (!userId) return next();
    const allowed = await checkRateLimit(userId, endpoint, limit, windowSec);
    if (!allowed) return apiError(res, ERR.RATE_LIMITED());
    next();
  };
}

// ─── VAPID ────────────────────────────────────────────────────────────────────
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

// ─── VALIDATION ───────────────────────────────────────────────────────────────
// Accepts both the short format (user-abcd1234), full UUID format, and the demo fallback
const USER_ID_RE = /^user-[a-f0-9]{8}$|^user-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^user-demo-[a-z0-9]+$/;

function validateUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

function validateTimezone(tz) {
  if (typeof tz !== 'string') return false;
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; }
  catch { return false; }
}

function validateSchedule(s) {
  if (!s || typeof s !== 'object') return false;
  const days   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const timeRe = /^\d{2}:\d{2}$/;
  for (const day of days) {
    const d = s[day];
    if (!d || typeof d.available !== 'boolean') return false;
    if (d.start && !timeRe.test(d.start)) return false;
    if (d.end   && !timeRe.test(d.end))   return false;
  }
  return true;
}

// ─── STRUCTURED ERRORS ────────────────────────────────────────────────────────
const ERR = {
  VALIDATION_ERROR: (msg)           => ({ status: 400, code: 'VALIDATION_ERROR', message: msg }),
  USER_NOT_FOUND:   ()              => ({ status: 404, code: 'USER_NOT_FOUND',    message: 'User not found' }),
  INVITE_EXPIRED:   ()              => ({ status: 410, code: 'INVITE_EXPIRED',    message: 'Invite link has expired' }),
  INVITE_USED:      ()              => ({ status: 410, code: 'INVITE_USED',       message: 'Invite link has already been used' }),
  INVITE_INVALID:   ()              => ({ status: 400, code: 'INVITE_INVALID',    message: 'Invalid invite link' }),
  INVITE_SELF:      ()              => ({ status: 400, code: 'INVITE_SELF',       message: 'Cannot add yourself' }),
  CALL_NOT_FOUND:   ()              => ({ status: 404, code: 'CALL_NOT_FOUND',    message: 'Call not found' }),
  CALL_RESPONDED:   ()              => ({ status: 409, code: 'CALL_RESPONDED',    message: 'Call already responded to' }),
  CALL_EXPIRED:     ()              => ({ status: 410, code: 'CALL_EXPIRED',      message: 'Call has expired' }),
  QUIET_HOURS:      (msg, time)     => ({ status: 403, code: 'QUIET_HOURS',       message: msg, localTime: time }),
  RATE_LIMITED:     ()              => ({ status: 429, code: 'RATE_LIMITED',      message: 'Too many requests. Please slow down.' }),
};

function apiError(res, err) {
  const body = { error: err.code, message: err.message };
  if (err.localTime) body.localTime = err.localTime;
  return res.status(err.status).json(body);
}

// ─── USER FACTORY ─────────────────────────────────────────────────────────────
function mkUser(id, name, timezone, avatar = '👋', avatarShape = 'circle') {
  return {
    id, name, timezone, avatar, avatarShape,
    schedule: defaultSchedule(),
    bestTimes: [],
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
  const h   = localHour(user.timezone);
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];
  const sched = user.schedule?.[day];
  if (!sched || !sched.available) return true;
  const toH   = t => { const [hh, mm] = (t || '').split(':').map(Number); return hh + (mm || 0) / 60; };
  const wake  = toH(sched.start || '08:00');
  const sleep = toH(sched.end   || '23:00');
  if (sleep > wake) return h < wake || h >= sleep;
  return h >= sleep && h < wake; // wraps midnight
}

// ─── PUSH HELPERS ─────────────────────────────────────────────────────────────
// Update pushValid for all friendships involving userId.
// O(friends) — uses per-user friend index, never scans all friendships.
async function updatePushValid(userId, isValid) {
  const friendIds = await db.friends.list(userId);
  await Promise.all(friendIds.map(async (friendId) => {
    const key = friendKey(userId, friendId);
    const f   = await db.friendships.get(key);
    if (!f) return;
    if (f.userA === userId) f.pushValidA = isValid;
    if (f.userB === userId) f.pushValidB = isValid;
    await db.friendships.set(key, f);
  }));
}

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
      await updatePushValid(userId, false);
    }
    return { ok: false, reason: e.message };
  }
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), env: process.env.NODE_ENV, vercel: !!process.env.VERCEL });
});

app.get('/api/vapid-public-key', (_req, res) => res.json({ key: VAPID_PUBLIC }));

// Heartbeat — client fires every 5 min; server skips write if already fresh
app.post('/api/heartbeat', rateLimit('heartbeat', 2, 60), async (req, res) => {
  const { userId } = req.body;
  if (!validateUserId(userId)) return apiError(res, ERR.VALIDATION_ERROR('Invalid userId'));

  let user = await db.users.get(userId);
  if (!user) {
    user = mkUser(userId, 'You', 'America/New_York');
    await db.users.set(userId, user);
    return res.json({ ok: true });
  }
  if (Date.now() - user.lastSeen < HEARTBEAT_SKIP_MS) return res.json({ ok: true });
  user.lastSeen = Date.now();
  await db.users.set(userId, user);
  res.json({ ok: true });
});

// Push subscription
app.post('/api/push/subscribe', async (req, res) => {
  const { userId, subscription } = req.body;
  if (!validateUserId(userId)) return apiError(res, ERR.VALIDATION_ERROR('Invalid userId'));

  let user = await db.users.get(userId);
  if (!user) user = mkUser(userId, 'You', 'America/New_York');
  user.pushSub  = subscription;
  user.lastSeen = Date.now();
  await db.users.set(userId, user);
  await updatePushValid(userId, true);
  res.json({ ok: true });
});

// Update profile
app.patch('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!validateUserId(userId)) return apiError(res, ERR.VALIDATION_ERROR('Invalid userId'));

  let user = await db.users.get(userId);
  if (!user) user = mkUser(userId, 'You', 'America/New_York');

  const { name, timezone, schedule, bestTimes, avatar, avatarShape } = req.body;
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 1)
      return apiError(res, ERR.VALIDATION_ERROR('Name must be a non-empty string'));
    user.name = name.trim().slice(0, 32);
  }
  if (timezone !== undefined) {
    if (!validateTimezone(timezone)) return apiError(res, ERR.VALIDATION_ERROR('Invalid timezone'));
    user.timezone = timezone;
  }
  if (schedule !== undefined) {
    if (!validateSchedule(schedule)) return apiError(res, ERR.VALIDATION_ERROR('Invalid schedule format'));
    user.schedule = schedule;
  }
  if (bestTimes !== undefined) {
    const valid = ['morning', 'afternoon', 'evening', 'night'];
    if (!Array.isArray(bestTimes) || bestTimes.some(t => !valid.includes(t)))
      return apiError(res, ERR.VALIDATION_ERROR('bestTimes must be array of morning|afternoon|evening|night'));
    user.bestTimes = bestTimes;
  }
  if (avatar !== undefined)      user.avatar      = String(avatar).slice(0, 8);
  if (avatarShape !== undefined) user.avatarShape  = ['circle', 'rounded', 'square'].includes(avatarShape) ? avatarShape : 'circle';

  await db.users.set(userId, user);
  res.json({ ok: true, user });
});

// Full account deletion — cascades to friendships and friend sets
app.delete('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!validateUserId(userId)) return apiError(res, ERR.VALIDATION_ERROR('Invalid userId'));

  const user = await db.users.get(userId);
  if (!user) return apiError(res, ERR.USER_NOT_FOUND());

  const friendIds = await db.friends.list(userId);
  await Promise.all([
    db.users.delete(userId),
    redis.del(`friends:${userId}`),
    ...friendIds.map(friendId => Promise.all([
      db.friendships.delete(friendKey(userId, friendId)),
      redis.srem(`friends:${friendId}`, userId),
    ])),
  ]);
  res.json({ ok: true });
});

// ── INVITES ───────────────────────────────────────────────────────────────────
app.post('/api/invites/create', rateLimit('invite', 3, 60), async (req, res) => {
  const { senderId } = req.body;
  if (!validateUserId(senderId)) return apiError(res, ERR.VALIDATION_ERROR('Invalid senderId'));

  let sender = await db.users.get(senderId);
  if (!sender) {
    sender = mkUser(senderId, 'You', 'America/New_York');
    await db.users.set(senderId, sender);
  }

  const token = jwt.sign(
    { senderId: sender.id, exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SEC },
    INVITE_SECRET
  );

  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host  = req.get('x-forwarded-host') || req.get('host');
  const base  = process.env.BASE_URL || `${proto}://${host}`;
  res.json({ token, url: `${base}/invite/${token}`, expiresAt: Date.now() + INVITE_TTL_SEC * 1000 });
});

app.get('/api/invites/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, INVITE_SECRET);
    const isUsed  = await db.invitesUsed.isUsed(req.params.token);
    if (isUsed) return apiError(res, ERR.INVITE_USED());

    const sender = await db.users.get(payload.senderId);
    if (!sender) return apiError(res, ERR.USER_NOT_FOUND());

    res.json({
      token: req.params.token,
      sender: { id: sender.id, name: sender.name, timezone: sender.timezone, avatar: sender.avatar },
      senderSchedule: sender.schedule,
      expiresAt: payload.exp * 1000,
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') return apiError(res, ERR.INVITE_EXPIRED());
    return apiError(res, ERR.INVITE_INVALID());
  }
});

app.post('/api/invites/:token/accept', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, INVITE_SECRET);

    // Early self-invite check when recipientId is known upfront
    if (req.body.recipientId && req.body.recipientId === payload.senderId) {
      return apiError(res, ERR.INVITE_SELF());
    }

    // Atomic claim: NX ensures only one concurrent accept wins the race
    const claimed = await db.invitesUsed.markUsed(req.params.token);
    if (!claimed) return apiError(res, ERR.INVITE_USED());

    const { name, timezone, schedule, bestTimes } = req.body;
    let { recipientId } = req.body;

    if (recipientId && !validateUserId(recipientId)) {
      return apiError(res, ERR.VALIDATION_ERROR('Invalid recipientId'));
    }
    if (!recipientId || !(await db.users.get(recipientId))) {
      recipientId = `user-${randomUUID().slice(0, 8)}`;
      await db.users.set(recipientId, mkUser(recipientId, name || 'Friend', timezone || 'UTC'));
    }

    const recip = await db.users.get(recipientId);
    if (name)                                      recip.name      = String(name).trim().slice(0, 32);
    if (timezone && validateTimezone(timezone))     recip.timezone  = timezone;
    if (schedule && validateSchedule(schedule))     recip.schedule  = schedule;
    if (bestTimes && Array.isArray(bestTimes))      recip.bestTimes = bestTimes;
    recip.lastSeen = Date.now();
    await db.users.set(recipientId, recip);

    const key = friendKey(payload.senderId, recipientId);
    let friendship = await db.friendships.get(key);
    if (!friendship) {
      const [a, b] = key.split(':');
      const [senderUser, recipUser] = await db.users.mget([a, b]);
      friendship = {
        userA: a, userB: b, since: Date.now(), lastCall: null,
        pushValidA: !!senderUser?.pushSub,
        pushValidB: !!recipUser?.pushSub,
      };
      await Promise.all([
        db.friendships.set(key, friendship),
        db.friends.add(payload.senderId, recipientId),
      ]);
    }

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
    if (err.name === 'TokenExpiredError') return apiError(res, ERR.INVITE_EXPIRED());
    return apiError(res, ERR.INVITE_INVALID());
  }
});

// ── FRIENDS ───────────────────────────────────────────────────────────────────
// O(friends) — per-user set for IDs, MGET for bulk user fetch, parallel for friendships
app.get('/api/friends/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!validateUserId(userId)) return apiError(res, ERR.VALIDATION_ERROR('Invalid userId'));

  let user = await db.users.get(userId);
  if (!user) {
    user = mkUser(userId, 'You', 'America/New_York');
    await db.users.set(userId, user);
  }

  const friendIds = await db.friends.list(userId);
  if (!friendIds.length) return res.json({ friends: [] });

  // One MGET for all friend profiles + parallel fetches for friendship metadata
  const [friendUsers, ...friendships] = await Promise.all([
    db.users.mget(friendIds),
    ...friendIds.map(fid => db.friendships.get(friendKey(userId, fid))),
  ]);

  const friends = [];
  for (let i = 0; i < friendIds.length; i++) {
    const friend = friendUsers[i];
    const f      = friendships[i];
    if (!friend || !f) continue;

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

// Manual add — allows tracking someone without them joining yet
app.post('/api/friends/manual', rateLimit('manual-add', 10, 60), async (req, res) => {
  const { userId, name, timezone } = req.body;
  if (!validateUserId(userId)) return apiError(res, ERR.VALIDATION_ERROR('Invalid userId'));
  if (!name || typeof name !== 'string' || name.trim().length < 1) 
    return apiError(res, ERR.VALIDATION_ERROR('Name is required'));
  if (!validateTimezone(timezone)) 
    return apiError(res, ERR.VALIDATION_ERROR('Invalid timezone'));

  const friendId = `user-shadow-${randomUUID().slice(0, 8)}`;
  const friendUser = mkUser(friendId, name.trim().slice(0, 32), timezone);
  
  const key = friendKey(userId, friendId);
  const friendship = {
    userA: userId, userB: friendId, since: Date.now(), lastCall: null,
    pushValidA: false, pushValidB: false // manual friends don't have push
  };

  await Promise.all([
    db.users.set(friendId, friendUser),
    db.friendships.set(key, friendship),
    db.friends.add(userId, friendId),
  ]);

  res.json({ ok: true, friend: friendUser });
});

// ── CALLS ─────────────────────────────────────────────────────────────────────
app.post('/api/calls/ping', rateLimit('ping', 5, 60), async (req, res) => {
  const { fromId, toId } = req.body;
  if (!validateUserId(fromId) || !validateUserId(toId))
    return apiError(res, ERR.VALIDATION_ERROR('Invalid fromId or toId'));

  const [from, to] = await db.users.mget([fromId, toId]);
  if (!from || !to) return apiError(res, ERR.USER_NOT_FOUND());

  if (isQuietHours(to)) {
    return apiError(res, ERR.QUIET_HOURS(
      `It's ${localTimeLabel(to.timezone)} for ${to.name} — ping held until they're up.`,
      localTimeLabel(to.timezone)
    ));
  }

  const callId = randomUUID();
  const call   = {
    id: callId, fromId, toId,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + CALL_TTL_SEC * 1000,
    deliveredAt: null, respondedAt: null,
  };
  await Promise.all([
    db.calls.set(callId, call),
    db.history.add(fromId, callId),
    db.history.add(toId, callId),
  ]);

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
  if (!call)                       return apiError(res, ERR.CALL_NOT_FOUND());
  if (call.status !== 'pending')   return apiError(res, ERR.CALL_RESPONDED());
  if (Date.now() > call.expiresAt) return apiError(res, ERR.CALL_EXPIRED());

  const { action, userId } = req.body;
  const validActions = ['yes', 'yes-30', 'no'];
  if (!validActions.includes(action)) return apiError(res, ERR.VALIDATION_ERROR('Invalid action'));

  call.status      = action === 'no' ? 'declined' : action === 'yes-30' ? 'deferred' : 'accepted';
  call.respondedAt = Date.now();
  await db.calls.set(req.params.callId, call);

  const key = friendKey(call.fromId, call.toId);
  const friendship = await db.friendships.get(key);
  if (friendship) {
    friendship.lastCall = Date.now();
    await db.friendships.set(key, friendship);
  }

  const [responder, from] = await db.users.mget([userId, call.fromId]);
  const msgs = {
    accepted: `${responder?.name || 'They'}'re free — call now!`,
    declined: `${responder?.name || 'They'} can't talk right now.`,
    deferred: `${responder?.name || 'They'}'ll be free in 30 min.`,
  };

  if (from && !isQuietHours(from)) {
    await sendPush(call.fromId, {
      type: 'call-response',
      title: msgs[call.status],
      body: call.status === 'accepted' ? 'Open the app to connect.' : '',
      data: { callId: call.id, response: call.status },
    });
  }

  res.json({ ok: true, status: call.status });
});

// ── HISTORY ───────────────────────────────────────────────────────────────────
app.get('/api/history/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!validateUserId(userId)) return apiError(res, ERR.VALIDATION_ERROR('Invalid userId'));

  const user = await db.users.get(userId);
  if (!user) return apiError(res, ERR.USER_NOT_FOUND());

  const callIds = await db.history.list(userId);
  if (!callIds.length) return res.json({ history: [] });

  // Bulk fetch all calls in history
  const calls = await Promise.all(callIds.map(id => db.calls.get(id)));
  
  // Collect unique user IDs from these calls to fetch profiles in one MGET
  const uniqueUserIds = [...new Set(calls.filter(Boolean).flatMap(c => [c.fromId, c.toId]))];
  const userProfiles  = await db.users.mget(uniqueUserIds);
  const profileMap    = Object.fromEntries(uniqueUserIds.map((id, i) => [id, userProfiles[i]]));

  const history = calls.filter(Boolean).map(c => {
    const isSender = c.fromId === userId;
    const peerId   = isSender ? c.toId : c.fromId;
    const peer     = profileMap[peerId];
    return {
      id:          c.id,
      type:        isSender ? 'sent' : 'received',
      status:      c.status,
      peer:        peer ? { id: peer.id, name: peer.name, avatar: peer.avatar, avatarShape: peer.avatarShape } : { id: peerId, name: 'Unknown' },
      createdAt:   c.createdAt,
      respondedAt: c.respondedAt,
    };
  });

  res.json({ history });
});

app.get('/api/calls/:callId', async (req, res) => {
  const call = await db.calls.get(req.params.callId);
  if (!call) return apiError(res, ERR.CALL_NOT_FOUND());
  res.json(call);
});

// ─── MIGRATION (run once after deploy, then this route is safe to leave) ──────
// POST /api/admin/migrate  — converts old hash keys to per-user keys
// Requires X-Migrate-Secret header matching MIGRATE_SECRET env var
app.post('/api/admin/migrate', async (req, res) => {
  const secret = req.headers['x-migrate-secret'];
  if (!secret || secret !== process.env.MIGRATE_SECRET) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const results = { users: 0, friendships: 0, errors: [] };

  // Migrate users hash → user:{id} keys
  try {
    const oldUsers = await redis.hgetall('users');
    if (oldUsers) {
      await Promise.all(Object.entries(oldUsers).map(async ([id, user]) => {
        try {
          const exists = await db.users.get(id);
          if (!exists) { await db.users.set(id, user); results.users++; }
        } catch (e) { results.errors.push(`user:${id}: ${e.message}`); }
      }));
    }
  } catch (e) { results.errors.push(`users hgetall: ${e.message}`); }

  // Migrate friendships hash → friendship:{key} keys + friends:{userId} sets
  try {
    const oldFriendships = await redis.hgetall('friendships');
    if (oldFriendships) {
      await Promise.all(Object.entries(oldFriendships).map(async ([key, f]) => {
        try {
          const exists = await db.friendships.get(key);
          if (!exists) {
            await Promise.all([
              db.friendships.set(key, f),
              db.friends.add(f.userA, f.userB),
            ]);
            results.friendships++;
          }
        } catch (e) { results.errors.push(`friendship:${key}: ${e.message}`); }
      }));
    }
  } catch (e) { results.errors.push(`friendships hgetall: ${e.message}`); }

  res.json({ ok: true, migrated: results });
});

// ─── PAGE ROUTES ──────────────────────────────────────────────────────────────
app.get(/^\/invite\/.*/, (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'invite.html')));
app.get('/onboarding.html', (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'onboarding.html')));
app.get(/.*/, (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'index.html')));

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
// Catches any unhandled Express errors; prevents stack trace leaks
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`ping → http://localhost:${PORT}`));
}

export default app;
