'use strict';

const CrmAuthAuditLog = require('../../models/CrmAuthAuditLog');
const CrmAuditLog = require('../../models/CrmAuditLog');
const CrmConsultancy = require('../../models/CrmConsultancy');
const CrmConsultancyAssignment = require('../../models/CrmConsultancyAssignment');
const CrmConsultancyFollowUp = require('../../models/CrmConsultancyFollowUp');
const CrmReferral = require('../../models/CrmReferral');
const CrmSession = require('../../models/CrmSession');
const CrmStudent = require('../../models/CrmStudent');
const CrmUser = require('../../models/CrmUser');
const { ADMISSION_STATUSES, OPEN_FOLLOW_UP_STATUSES } = require('../../constants/crm');
const { PRESENCE_ONLINE_MS } = require('../../constants/crmPresence');
const { CRM_ROLES } = require('../../constants/crmUsers');
const { CrmError } = require('../../utils/crmError');
const { parseObjectId, parsePageLimit } = require('../../utils/crmHttp');
const { calendarDayKey, resolveAnalyticsRange } = require('../../utils/crmRange');
const { reportingConsultancyIds, reportingScopeBasis } = require('./crmAccess');

const KEYS = Object.freeze([
  'date',
  'timeZone',
  'from',
  'to',
  'consultancyPage',
  'consultancyLimit',
  'studentPage',
  'studentLimit',
  'studentQ',
  'admissionStatus',
  'consultancyId',
  'followUpState',
]);

const LIMITATIONS = Object.freeze([
  'Observed session duration uses session createdAt and a reliable end (revokedAt, else expiresAt when expired, else “now” for an open session). Heartbeat lastSeenAt is freshness only and is not used as working time.',
  'Overlapping session intervals on the same calendar day are merged before summing so the same clock time is never counted twice.',
  'Idle time is not available: the product does not store measured active-vs-idle spans.',
  'Students are those whose current referral consultancy is among the staff member’s current active assignments. Historical work on students no longer linked that way is omitted from the portfolio.',
  'Follow-up open/overdue counts use surviving follow-up rows on assigned consultancies and are shared across all current assignees of that consultancy.',
  'Business-event counts are audit volume for this actor, not a productivity score.',
  'Asia/Kolkata is used only when the caller sends timeZone=Asia/Kolkata. Confirmation of that zone is pending.',
]);

function assertManager(actor) {
  if (!actor) throw new CrmError(401, 'Authentication required', 'authentication_required');
  if (actor.actorType === 'admin' || actor.kind === 'admin') return;
  const permissions = actor.permissions || [];
  if ((actor.actorType === 'crm-user' || actor.kind === 'crm-user') && permissions.includes('crm.roles.manage')) return;
  throw new CrmError(403, 'CRM Access Management is required to inspect staff 360 profiles.', 'permission_denied');
}

function assertKeys(query) {
  Object.keys(query || {}).forEach((key) => {
    if (!KEYS.includes(key)) {
      throw new CrmError(400, `${key} is not a supported staff 360 filter.`, 'unsupported_filter');
    }
  });
}

function pageOf(query, pageKey, limitKey) {
  return parsePageLimit({
    page: query[pageKey] == null || query[pageKey] === '' ? 1 : query[pageKey],
    limit: query[limitKey] == null || query[limitKey] === '' ? 10 : query[limitKey],
  });
}

function dayRange(query, now) {
  const timeZone = query.timeZone == null || query.timeZone === '' ? 'UTC' : String(query.timeZone);
  const date = query.date == null || query.date === ''
    ? calendarDayKey(now, timeZone)
    : String(query.date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new CrmError(400, 'date must be YYYY-MM-DD.', 'invalid_query');
  }
  return resolveAnalyticsRange({ period: 'custom', from: date, to: date, timeZone });
}

function analyticsRange(query, day) {
  const from = query.from == null || query.from === '' ? day.from : String(query.from).trim();
  const to = query.to == null || query.to === '' ? day.to : String(query.to).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new CrmError(400, 'from and to must be YYYY-MM-DD dates.', 'invalid_query');
  }
  return resolveAnalyticsRange({ period: 'custom', from, to, timeZone: day.timeZone });
}

function presenceState(sessions, user, now) {
  if (!user || user.status === 'inactive') return 'inactive';
  if (user.status === 'invited') return 'invited';
  const active = (sessions || []).filter((row) => !row.revokedAt && new Date(row.expiresAt).getTime() > now.getTime());
  if (!active.length) return 'offline';
  const freshest = Math.max(...active.map((row) => (row.lastSeenAt ? new Date(row.lastSeenAt).getTime() : 0)));
  if (freshest && now.getTime() - freshest <= PRESENCE_ONLINE_MS) return 'online';
  return 'idle';
}

function sessionEnd(session, now) {
  if (session.revokedAt) {
    return { at: new Date(session.revokedAt), reason: 'revoked', reliable: true, open: false };
  }
  const expiresAt = new Date(session.expiresAt);
  if (expiresAt.getTime() <= now.getTime()) {
    return { at: expiresAt, reason: 'expired', reliable: true, open: false };
  }
  return { at: now, reason: 'open', reliable: true, open: true };
}

// Clip each session to the day window, then merge overlaps so duration is not double-counted.
function daySessionMetrics(sessions, dayStart, dayEnd, now) {
  const intervals = [];
  const timeline = [];
  sessions.forEach((session) => {
    const createdAt = new Date(session.createdAt);
    const endInfo = sessionEnd(session, now);
    const startMs = Math.max(createdAt.getTime(), dayStart.getTime());
    const endMs = Math.min(endInfo.at.getTime(), dayEnd.getTime());
    const overlaps = createdAt.getTime() <= dayEnd.getTime() && endInfo.at.getTime() >= dayStart.getTime();
    timeline.push({
      id: String(session._id),
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt || null,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt || null,
      endedReason: endInfo.reason,
      open: endInfo.open,
      overlapsSelectedDay: overlaps,
      observedStartAt: overlaps && endMs > startMs ? new Date(startMs).toISOString() : null,
      observedEndAt: overlaps && endMs > startMs ? new Date(endMs).toISOString() : null,
      observedMs: overlaps && endMs > startMs ? endMs - startMs : 0,
      durationBasis: 'createdAt_to_revokedAt_or_expiresAt_or_now',
    });
    if (overlaps && endMs > startMs) intervals.push([startMs, endMs]);
  });
  intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  intervals.forEach((interval) => {
    if (!merged.length || interval[0] > merged[merged.length - 1][1]) {
      merged.push(interval.slice());
      return;
    }
    merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], interval[1]);
  });
  const totalMs = merged.reduce((sum, interval) => sum + (interval[1] - interval[0]), 0);
  const open = timeline.filter((row) => row.open && row.overlapsSelectedDay);
  return {
    totalObservedMs: totalMs,
    totalObservedLabel: 'Merged observed session spans on this calendar day. Not working time.',
    openSessionCount: open.length,
    openObservedMs: open.reduce((sum, row) => sum + row.observedMs, 0),
    idleTimeAvailable: false,
    idleTime: null,
    intervalsMerged: merged.length,
    sessions: timeline.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
  };
}

function isOpenFollowUp(row) {
  return Boolean(
    !row.completedAt
    && !row.cancelledAt
    && OPEN_FOLLOW_UP_STATUSES.includes(row.status)
  );
}

function followUpBucket(row, now, todayEnd) {
  if (row.completedAt) return 'completed';
  if (row.cancelledAt) return 'cancelled';
  if (!isOpenFollowUp(row)) return 'other';
  if (!row.scheduledAt) return 'unscheduled';
  const when = new Date(row.scheduledAt).getTime();
  if (when < now.getTime()) return 'overdue';
  if (when <= todayEnd.getTime()) return 'due_today';
  return 'upcoming';
}

function admissionTone(status) {
  if (!status) return 'Not started';
  return ADMISSION_STATUSES.includes(status) ? status : 'Not started';
}

async function getStaff360(actor, userIdParam, query = {}, now = new Date()) {
  assertManager(actor);
  assertKeys(query);
  const userId = parseObjectId(userIdParam, 'User id');
  const user = await CrmUser.findOne({ _id: userId, deletedAt: null }).lean();
  if (!user) throw new CrmError(404, 'CRM user not found.', 'not_found');

  const day = dayRange(query, now);
  const range = analyticsRange(query, day);
  const consultancyPager = pageOf(query, 'consultancyPage', 'consultancyLimit');
  const studentPager = pageOf(query, 'studentPage', 'studentLimit');
  const studentQ = query.studentQ == null ? '' : String(query.studentQ).trim().slice(0, 100);
  const admissionStatus = query.admissionStatus == null || query.admissionStatus === ''
    ? ''
    : String(query.admissionStatus);
  const followUpState = query.followUpState == null || query.followUpState === ''
    ? ''
    : String(query.followUpState);
  const filterConsultancyId = query.consultancyId == null || query.consultancyId === ''
    ? null
    : parseObjectId(String(query.consultancyId), 'Consultancy id');

  const callerScope = await reportingConsultancyIds(actor);
  const assignedIds = await CrmConsultancyAssignment.find({ crmUserId: userId, revokedAt: null })
    .sort({ createdAt: 1, _id: 1 })
    .select('consultancyId createdAt')
    .lean();
  let visibleIds = assignedIds.map((row) => row.consultancyId);
  if (callerScope != null) {
    const allowed = new Set(callerScope.map(String));
    visibleIds = visibleIds.filter((id) => allowed.has(String(id)));
  }
  if (filterConsultancyId) {
    visibleIds = visibleIds.filter((id) => String(id) === String(filterConsultancyId));
  }

  const [
    sessions,
    loginEvents,
    consultancies,
    referralRows,
    followUps,
    businessByAction,
    recentBusiness,
    latestBusiness,
  ] = await Promise.all([
    CrmSession.find({
      userId,
      createdAt: { $lte: day.end },
      $or: [
        { revokedAt: null },
        { revokedAt: { $gte: day.start } },
      ],
    }).sort({ createdAt: -1, _id: -1 }).lean(),
    CrmAuthAuditLog.find({
      action: 'crm_user.login_succeeded',
      targetUserId: userId,
      createdAt: { $gte: day.start, $lte: day.end },
    }).sort({ createdAt: 1, _id: 1 }).select('createdAt actorCrmUserId').lean(),
    visibleIds.length
      ? CrmConsultancy.find({ _id: { $in: visibleIds }, deletedAt: null }).select('name status updatedAt').lean()
      : [],
    visibleIds.length
      ? CrmReferral.aggregate([
        { $match: { consultancyId: { $in: visibleIds } } },
        { $sort: { referredAt: -1, _id: -1 } },
        {
          $group: {
            _id: '$crmStudentId',
            consultancyId: { $first: '$consultancyId' },
            referredAt: { $first: '$referredAt' },
            referralId: { $first: '$_id' },
          },
        },
      ])
      : [],
    visibleIds.length
      ? CrmConsultancyFollowUp.find({ consultancyId: { $in: visibleIds } })
        .sort({ scheduledAt: 1, createdAt: -1 })
        .limit(2000)
        .lean()
      : [],
    CrmAuditLog.aggregate([
      {
        $match: {
          actorCrmUserId: userId,
          createdAt: { $gte: range.start, $lte: range.end },
        },
      },
      { $group: { _id: '$action', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    CrmAuditLog.find({
      actorCrmUserId: userId,
      createdAt: { $gte: range.start, $lte: range.end },
    }).sort({ createdAt: -1, _id: -1 }).limit(20).lean(),
    CrmAuditLog.findOne({ actorCrmUserId: userId }).sort({ createdAt: -1, _id: -1 }).select('createdAt action').lean(),
  ]);

  // Also include sessions created on the day even if revoked earlier filter missed edge cases
  const daySessions = await CrmSession.find({
    userId,
    createdAt: { $lte: day.end },
    $or: [
      { revokedAt: null, expiresAt: { $gte: day.start } },
      { revokedAt: { $gte: day.start } },
      { createdAt: { $gte: day.start, $lte: day.end } },
    ],
  }).lean();

  const sessionMetrics = daySessionMetrics(daySessions.length ? daySessions : sessions, day.start, day.end, now);
  const activeSessions = daySessions.filter((row) => !row.revokedAt && new Date(row.expiresAt).getTime() > now.getTime());
  const lastSeenAt = daySessions
    .map((row) => row.lastSeenAt)
    .filter(Boolean)
    .sort((left, right) => new Date(right) - new Date(left))[0] || null;

  const assignmentAt = new Map(assignedIds.map((row) => [String(row.consultancyId), row.createdAt]));
  const consultancyById = new Map(consultancies.map((row) => [String(row._id), row]));
  const studentIds = referralRows.map((row) => row._id).filter(Boolean);
  const students = studentIds.length
    ? await CrmStudent.find({ _id: { $in: studentIds }, deletedAt: null })
      .select('fullName admissionStatus phone updatedAt createdAt')
      .lean()
    : [];
  const studentById = new Map(students.map((row) => [String(row._id), row]));

  const followUpsByConsultancy = new Map();
  followUps.forEach((row) => {
    const key = String(row.consultancyId);
    const list = followUpsByConsultancy.get(key) || [];
    list.push(row);
    followUpsByConsultancy.set(key, list);
  });

  const studentsByConsultancy = new Map();
  referralRows.forEach((row) => {
    const key = String(row.consultancyId);
    const list = studentsByConsultancy.get(key) || [];
    list.push(row);
    studentsByConsultancy.set(key, list);
  });

  const consultancyItems = visibleIds.map((id) => {
    const key = String(id);
    const consultancy = consultancyById.get(key);
    const linked = studentsByConsultancy.get(key) || [];
    const statusCounts = {};
    ADMISSION_STATUSES.forEach((status) => { statusCounts[status] = 0; });
    statusCounts['Not started'] = 0;
    linked.forEach((ref) => {
      const student = studentById.get(String(ref._id));
      const status = admissionTone(student && student.admissionStatus);
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });
    const ownedFollowUps = followUpsByConsultancy.get(key) || [];
    const open = ownedFollowUps.filter((row) => isOpenFollowUp(row));
    const overdue = ownedFollowUps.filter((row) => followUpBucket(row, now, day.end) === 'overdue');
    const upcoming = ownedFollowUps.filter((row) => followUpBucket(row, now, day.end) === 'upcoming' || followUpBucket(row, now, day.end) === 'due_today');
    return {
      id: key,
      name: consultancy ? consultancy.name : '',
      status: consultancy ? consultancy.status : null,
      assignedAt: assignmentAt.get(key) || null,
      students: linked.length,
      admissionStatus: statusCounts,
      openFollowUps: open.length,
      overdueFollowUps: overdue.length,
      upcomingFollowUps: upcoming.length,
      lastUpdatedAt: consultancy ? consultancy.updatedAt : null,
    };
  }).filter((row) => row.name || row.students)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  const consultancyTotal = consultancyItems.length;
  const consultancyPageItems = consultancyItems.slice(consultancyPager.skip, consultancyPager.skip + consultancyPager.limit);

  let studentItems = referralRows.map((ref) => {
    const student = studentById.get(String(ref._id));
    if (!student) return null;
    const consultancy = consultancyById.get(String(ref.consultancyId));
    const owned = (followUpsByConsultancy.get(String(ref.consultancyId)) || [])
      .filter((row) => isOpenFollowUp(row))
      .sort((left, right) => {
        const leftAt = left.scheduledAt ? new Date(left.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER;
        const rightAt = right.scheduledAt ? new Date(right.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER;
        return leftAt - rightAt;
      })[0] || null;
    const bucket = owned ? followUpBucket(owned, now, day.end) : 'none';
    return {
      id: String(student._id),
      fullName: student.fullName,
      phone: student.phone || null,
      consultancyId: String(ref.consultancyId),
      consultancyName: consultancy ? consultancy.name : '',
      admissionStatus: admissionTone(student.admissionStatus),
      referredAt: ref.referredAt || null,
      updatedAt: student.updatedAt || null,
      nextFollowUpAt: owned && owned.scheduledAt ? owned.scheduledAt : null,
      followUpState: bucket,
      // Cohort is referral→assigned consultancy, not personal ownership of the student.
      responsibleStaffId: String(userId),
      responsibleStaffName: user.fullName || '',
    };
  }).filter(Boolean);

  const allStudents = studentItems.slice();
  if (studentQ) {
    const needle = studentQ.toLowerCase();
    studentItems = studentItems.filter((row) => row.fullName.toLowerCase().includes(needle));
  }
  if (admissionStatus) {
    studentItems = studentItems.filter((row) => row.admissionStatus === admissionStatus);
  }
  if (followUpState) {
    studentItems = studentItems.filter((row) => row.followUpState === followUpState);
  }
  studentItems.sort((left, right) => left.fullName.localeCompare(right.fullName) || left.id.localeCompare(right.id));
  const studentTotal = studentItems.length;
  const studentPageItems = studentItems.slice(studentPager.skip, studentPager.skip + studentPager.limit);

  const openFollowUps = followUps.filter((row) => isOpenFollowUp(row));
  const overdueFollowUps = followUps.filter((row) => followUpBucket(row, now, day.end) === 'overdue');
  const dueTodayFollowUps = followUps.filter((row) => followUpBucket(row, now, day.end) === 'due_today');
  const upcomingFollowUps = followUps.filter((row) => followUpBucket(row, now, day.end) === 'upcoming');
  const admissionDistribution = ADMISSION_STATUSES.map((status) => ({
    status,
    count: allStudents.filter((row) => row.admissionStatus === status).length,
  }));
  const notStarted = allStudents.filter((row) => row.admissionStatus === 'Not started').length;
  if (notStarted) admissionDistribution.unshift({ status: 'Not started', count: notStarted });

  const businessTotal = businessByAction.reduce((sum, row) => sum + row.count, 0);
  const createdStudents = businessByAction.find((row) => row._id === 'student.created');
  const updatedStudents = businessByAction.find((row) => row._id === 'student.updated');

  return {
    generatedAt: now.toISOString(),
    timeZone: day.timeZone,
    timeZoneConfirmed: false,
    scopeBasis: reportingScopeBasis(actor),
    limitations: LIMITATIONS,
    definitions: {
      observedSessionDuration: 'Sum of merged [max(createdAt, dayStart), min(end, dayEnd)] intervals where end is revokedAt, else expiresAt when expired, else now for an open session.',
      students: 'Distinct students whose current referral consultancy is among this staff member’s current active assignments visible to the caller.',
      followUps: 'Surviving follow-up rows on those consultancies. Shared across all current assignees.',
      businessEvents: 'CrmAuditLog rows with actorCrmUserId equal to this staff member in the selected analytics range.',
    },
    profile: {
      id: String(user._id),
      fullName: user.fullName,
      email: user.email,
      username: user.username,
      role: user.role,
      roleLabel: CRM_ROLES[user.role] ? CRM_ROLES[user.role].label : user.role,
      status: user.status,
      presence: presenceState(activeSessions, user, now),
      lastLoginAt: user.lastLoginAt || null,
      lastSeenAt,
      lastBusinessAt: latestBusiness ? latestBusiness.createdAt : null,
      lastBusinessAction: latestBusiness ? latestBusiness.action : null,
      onlineThresholdMs: PRESENCE_ONLINE_MS,
    },
    day: {
      date: day.from,
      start: day.start,
      end: day.end,
      firstLoginAt: loginEvents[0] ? loginEvents[0].createdAt : null,
      lastLoginAt: loginEvents.length ? loginEvents[loginEvents.length - 1].createdAt : null,
      loginCount: loginEvents.length,
      sessions: sessionMetrics,
    },
    range: { from: range.from, to: range.to, start: range.start, end: range.end },
    summary: {
      assignedConsultancies: consultancyTotal,
      assignedStudents: studentTotal,
      openFollowUps: openFollowUps.length,
      overdueFollowUps: overdueFollowUps.length,
      dueTodayFollowUps: dueTodayFollowUps.length,
      upcomingFollowUps: upcomingFollowUps.length,
      businessEvents: businessTotal,
      studentsCreatedRecorded: createdStudents ? createdStudents.count : 0,
      studentUpdatesRecorded: updatedStudents ? updatedStudents.count : 0,
      // Completed-in-period is not a stored snapshot on this endpoint; omit rather than invent.
      meaning: {
        assignedConsultancies: 'Current active assignment rows for this staff member, intersected with the caller’s reporting scope.',
        assignedStudents: 'Distinct students via current referral → assigned consultancy.',
        openFollowUps: 'Open follow-up rows on those consultancies.',
        overdueFollowUps: 'Open follow-ups with scheduledAt before now.',
        dueTodayFollowUps: 'Open follow-ups scheduled later today.',
        upcomingFollowUps: 'Open follow-ups scheduled after today.',
        businessEvents: 'Audit events attributed to this staff member in the analytics range. Not productivity.',
      },
    },
    admissionDistribution,
    businessByAction: businessByAction.map((row) => ({ action: row._id, count: row.count })),
    recentBusiness: recentBusiness.map((row) => ({
      id: String(row._id),
      createdAt: row.createdAt,
      action: row.action,
      entityType: row.entityType || null,
      entityId: row.entityId ? String(row.entityId) : null,
      summary: row.action,
    })),
    consultancies: {
      page: consultancyPager.page,
      limit: consultancyPager.limit,
      total: consultancyTotal,
      items: consultancyPageItems,
    },
    students: {
      page: studentPager.page,
      limit: studentPager.limit,
      total: studentTotal,
      items: studentPageItems,
    },
  };
}

module.exports = {
  getStaff360,
  daySessionMetrics,
  sessionEnd,
};
