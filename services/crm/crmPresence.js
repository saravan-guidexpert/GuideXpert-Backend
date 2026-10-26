'use strict';

const CrmSession = require('../../models/CrmSession');
const CrmUser = require('../../models/CrmUser');
const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../../models/CrmConsultancyAssignment');
const { CrmError } = require('../../utils/crmError');
const { parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const { commitWithAudit } = require('../../utils/crmMutation');
const { writeAuthAudit } = require('./crmAuthAudit');
const { revokeSessions } = require('./crmUserAdminService');
const {
  PRESENCE_ONLINE_MS,
  PRESENCE_WRITE_INTERVAL_MS,
  PRESENCE_HEARTBEAT_WINDOW_MS,
  heartbeatMaxPerWindow,
} = require('../../constants/crmPresence');
const { consumeRateLimit, resetRateLimitsForTests } = require('./crmRateLimit');

function resetHeartbeatLimiterForTests() {
  resetRateLimitsForTests();
}

function consumeHeartbeat(sessionId, now = Date.now()) {
  return consumeRateLimit(
    `heartbeat:${sessionId}`,
    heartbeatMaxPerWindow(),
    PRESENCE_HEARTBEAT_WINDOW_MS,
    now
  );
}

function assertCanView(actor) {
  if (!actor) throw new CrmError(401, 'Authentication required', 'authentication_required');
  if (actor.kind === 'admin') return;
  if (actor.kind === 'crm-user' && (actor.permissions || []).includes('crm.roles.manage')) return;
  throw new CrmError(403, 'You do not have permission to view CRM sessions.', 'permission_denied');
}

function assertCanRevoke(actor) {
  if (!actor) throw new CrmError(401, 'Authentication required', 'authentication_required');
  if (actor.kind === 'admin') return;
  if (actor.kind === 'crm-user' && (actor.permissions || []).includes('crm.users.deactivate')) return;
  throw new CrmError(403, 'You do not have permission to revoke CRM sessions.', 'permission_denied');
}

function auditActor(actor) {
  if (actor.kind === 'admin') return { actorAdminId: actor.id };
  return { actorCrmUserId: actor.id };
}

function classifySession(session, user, now) {
  const nowMs = now.getTime();
  if (!session || session.revokedAt) return { state: 'ended', endedReason: 'revoked', valid: false };
  if (new Date(session.expiresAt).getTime() <= nowMs) return { state: 'ended', endedReason: 'expired', valid: false };
  if (!user || user.deletedAt || user.status !== 'active' || session.sessionVersion !== user.sessionVersion) {
    return { state: 'ended', endedReason: 'superseded', valid: false };
  }
  const seen = session.lastSeenAt ? new Date(session.lastSeenAt).getTime() : 0;
  if (seen && nowMs - seen <= PRESENCE_ONLINE_MS) {
    return { state: 'online', endedReason: null, valid: true };
  }
  return { state: 'idle', endedReason: null, valid: true };
}

function userState(sessions, user, now) {
  const rows = sessions.map((session) => classifySession(session, user, now));
  if (rows.some((row) => row.state === 'online')) return 'online';
  if (rows.some((row) => row.state === 'idle')) return 'idle';
  return 'offline';
}

function presentSession(session, user, now, currentSessionId) {
  const classified = classifySession(session, user, now);
  return {
    id: String(session._id),
    current: currentSessionId ? String(session._id) === String(currentSessionId) : false,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt || null,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt || null,
    remember: session.remember === true,
    state: classified.state,
    endedReason: classified.endedReason,
    ip: session.ip || null,
    userAgent: session.userAgent || null,
  };
}

function rejectForeignIdentity(body) {
  const names = ['userId', 'crmUserId', 'sessionId', 'targetUserId'];
  if (names.some((key) => body && Object.prototype.hasOwnProperty.call(body, key))) {
    throw new CrmError(400, 'Presence follows the signed-in session.', 'invalid_body');
  }
}

async function heartbeat(req) {
  rejectForeignIdentity(req.body || {});
  const session = req.crmSession;
  const user = req.crmUser;
  if (!(await consumeHeartbeat(String(session._id)))) {
    throw new CrmError(429, 'Too many presence updates. Try again later.', 'rate_limited');
  }
  const now = new Date();
  const seenAt = session.lastSeenAt ? new Date(session.lastSeenAt).getTime() : 0;
  if (!seenAt || now.getTime() - seenAt >= PRESENCE_WRITE_INTERVAL_MS) {
    const result = await CrmSession.updateOne(
      {
        _id: session._id,
        userId: user._id,
        revokedAt: null,
        expiresAt: session.expiresAt,
        sessionVersion: user.sessionVersion,
      },
      { $set: { lastSeenAt: now } }
    );
    const matched = result.matchedCount == null ? result.n : result.matchedCount;
    if (!matched) {
      throw new CrmError(401, 'Session expired', 'session_revoked');
    }
    session.lastSeenAt = now;
  }
  const classified = classifySession(session, user, now);
  return {
    status: 200,
    body: {
      success: true,
      data: {
        state: classified.state,
        lastSeenAt: session.lastSeenAt || null,
        expiresAt: session.expiresAt,
        sessionId: String(session._id),
        onlineThresholdMs: PRESENCE_ONLINE_MS,
      },
    },
  };
}

async function ownPresence(req, query) {
  const { page, limit, skip } = parsePageLimit(query);
  const now = new Date();
  const user = req.crmUser;
  const [items, total, active, latest] = await Promise.all([
    CrmSession.find({ userId: user._id }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CrmSession.countDocuments({ userId: user._id }),
    CrmSession.find({
      userId: user._id,
      revokedAt: null,
      expiresAt: { $gt: now },
    }).select('lastSeenAt expiresAt revokedAt sessionVersion').lean(),
    CrmSession.findOne({ userId: user._id, lastSeenAt: { $ne: null } }).sort({ lastSeenAt: -1 }).select('lastSeenAt').lean(),
  ]);
  return {
    state: userState(active, user, now),
    lastSeenAt: latest && latest.lastSeenAt ? latest.lastSeenAt : null,
    onlineThresholdMs: PRESENCE_ONLINE_MS,
    writeIntervalMs: PRESENCE_WRITE_INTERVAL_MS,
    currentSessionId: String(req.crmSession._id),
    sessions: {
      items: items.map((session) => presentSession(session, user, now, req.crmSession._id)),
      page,
      limit,
      total,
    },
  };
}

async function loadPresenceMap(users, now = new Date()) {
  const ids = users.map((user) => user._id);
  const map = new Map();
  if (ids.length === 0) return map;
  const [activeSessions, lastSeenRows] = await Promise.all([
    CrmSession.find({
      userId: { $in: ids },
      revokedAt: null,
      expiresAt: { $gt: now },
    }).select('userId lastSeenAt expiresAt revokedAt sessionVersion').lean(),
    CrmSession.aggregate([
      { $match: { userId: { $in: ids }, lastSeenAt: { $type: 'date' } } },
      { $group: { _id: '$userId', lastSeenAt: { $max: '$lastSeenAt' } } },
    ]),
  ]);
  const activeByUser = new Map();
  activeSessions.forEach((session) => {
    const key = String(session.userId);
    const list = activeByUser.get(key) || [];
    list.push(session);
    activeByUser.set(key, list);
  });
  const seenByUser = new Map(lastSeenRows.map((row) => [String(row._id), row.lastSeenAt]));
  users.forEach((user) => {
    const key = String(user._id);
    const sessions = activeByUser.get(key) || [];
    map.set(key, {
      state: userState(sessions, user, now),
      lastSeenAt: seenByUser.get(key) || null,
      activeSessions: sessions.filter((session) => classifySession(session, user, now).valid).length,
    });
  });
  return map;
}

async function listPresence(actor, query) {
  assertCanView(actor);
  const { page, limit, skip } = parsePageLimit(query);
  const filter = { deletedAt: null };
  if (query.consultancyId) {
    const consultancyId = parseObjectId(query.consultancyId, 'Consultancy id');
    const consultancy = await CrmConsultancy.findOne({ _id: consultancyId, deletedAt: null }).select('_id').lean();
    if (!consultancy) throw new CrmError(404, 'Consultancy not found.', 'not_found');
    const assignedIds = await CrmConsultancyAssignment.find({
      consultancyId,
      revokedAt: null,
    }).distinct('crmUserId');
    filter._id = { $in: assignedIds };
  }
  const [users, total] = await Promise.all([
    CrmUser.find(filter)
      .sort({ fullName: 1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .select('fullName email status role sessionVersion')
      .lean(),
    CrmUser.countDocuments(filter),
  ]);
  const presence = await loadPresenceMap(users, new Date());
  return {
    items: users.map((user) => {
      const row = presence.get(String(user._id));
      return {
        userId: String(user._id),
        fullName: user.fullName,
        email: user.email,
        status: user.status,
        role: user.role,
        state: row.state,
        lastSeenAt: row.lastSeenAt,
        activeSessions: row.activeSessions,
      };
    }),
    page,
    limit,
    total,
    onlineThresholdMs: PRESENCE_ONLINE_MS,
  };
}

async function listSessions(actor, userIdParam, query) {
  assertCanView(actor);
  const userId = parseObjectId(userIdParam, 'User id');
  const user = await CrmUser.findOne({ _id: userId, deletedAt: null }).lean();
  if (!user) throw new CrmError(404, 'CRM user not found.', 'not_found');
  const { page, limit, skip } = parsePageLimit(query);
  const now = new Date();
  const [items, total, active, latest] = await Promise.all([
    CrmSession.find({ userId }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    CrmSession.countDocuments({ userId }),
    CrmSession.find({ userId, revokedAt: null, expiresAt: { $gt: now } }).lean(),
    CrmSession.findOne({ userId, lastSeenAt: { $ne: null } }).sort({ lastSeenAt: -1 }).select('lastSeenAt').lean(),
  ]);
  return {
    user: {
      id: String(user._id),
      fullName: user.fullName,
      status: user.status,
      state: userState(active, user, now),
      lastSeenAt: latest && latest.lastSeenAt ? latest.lastSeenAt : null,
    },
    items: items.map((session) => presentSession(session, user, now, null)),
    page,
    limit,
    total,
    onlineThresholdMs: PRESENCE_ONLINE_MS,
  };
}

function rejectSelf(actor, userId) {
  if (actor.kind === 'crm-user' && String(actor.id) === String(userId)) {
    throw new CrmError(403, 'Use sign-out to end your own session.', 'permission_denied');
  }
}

async function revokeOne(actor, userIdParam, sessionIdParam, req) {
  assertCanRevoke(actor);
  const userId = parseObjectId(userIdParam, 'User id');
  const sessionId = parseObjectId(sessionIdParam, 'Session id');
  rejectSelf(actor, userId);
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (dbSession) => {
      const user = await CrmUser.findOne({ _id: userId, deletedAt: null }).session(dbSession);
      if (!user) throw new CrmError(404, 'CRM user not found.', 'not_found');
      const current = await CrmSession.findOne({ _id: sessionId, userId: user._id }).session(dbSession);
      if (!current) throw new CrmError(404, 'Session not found.', 'not_found');
      if (current.revokedAt) return { already: true, user, session: current };
      current.revokedAt = new Date();
      await current.save({ session: dbSession });
      return { already: false, user, session: current };
    },
    audit: (dbSession, saved) => {
      if (saved.already) return null;
      return writeAuthAudit({
        ...auditActor(actor),
        targetUserId: saved.user._id,
        action: 'crm_session.revoked',
        after: { sessionId: String(saved.session._id), scope: 'one' },
      }, req, dbSession);
    },
  });
  return presentSession(payload.session, payload.user, new Date(), null);
}

async function revokeAll(actor, userIdParam, req) {
  assertCanRevoke(actor);
  const userId = parseObjectId(userIdParam, 'User id');
  rejectSelf(actor, userId);
  const { payload } = await commitWithAudit({
    requireTransaction: true,
    mutate: async (dbSession) => {
      const user = await CrmUser.findOne({ _id: userId, deletedAt: null }).session(dbSession);
      if (!user) throw new CrmError(404, 'CRM user not found.', 'not_found');
      const active = await CrmSession.countDocuments({ userId: user._id, revokedAt: null }).session(dbSession);
      await revokeSessions(user, dbSession);
      await user.save({ session: dbSession });
      return { user, revokedCount: active };
    },
    audit: (dbSession, saved) => writeAuthAudit({
      ...auditActor(actor),
      targetUserId: saved.user._id,
      action: 'crm_session.revoked_all',
      after: { revokedCount: saved.revokedCount, scope: 'all' },
    }, req, dbSession),
  });
  return { revokedCount: payload.revokedCount, state: 'offline' };
}

module.exports = {
  heartbeat,
  ownPresence,
  listPresence,
  listSessions,
  loadPresenceMap,
  revokeOne,
  revokeAll,
  resetHeartbeatLimiterForTests,
};
