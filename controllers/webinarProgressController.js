const { ADMIN_LIST_MAX_LIMIT } = require('../constants/listPagination');
const WebinarProgress = require('../models/WebinarProgress');
const WebinarProgress2627 = require('../models/WebinarProgress2627');
const WebinarAssessmentSubmission = require('../models/WebinarAssessmentSubmission');
const { getWebinarUserFromToken, webinarAuthErrorResponse } = require('../utils/webinarJwtAuth');

function progressModel(req) {
  return req.webinarProgressModel || WebinarProgress;
}

function assessmentTrainingYearMatch(req) {
  const cohort = req.webinarAssessmentCohort === '26-27' ? '26-27' : '25-26';
  if (cohort === '26-27') return { trainingYear: '26-27' };
  return { $or: [{ trainingYear: { $exists: false } }, { trainingYear: '25-26' }] };
}

function bindWebinarProgressCohort(ProgressModel, assessmentCohort) {
  return (req, _res, next) => {
    req.webinarProgressModel = ProgressModel;
    req.webinarAssessmentCohort = assessmentCohort;
    next();
  };
}

const STATUS_RANK = { locked: 0, unlocked: 1, in_progress: 2, completed: 3 };
const ALL_MODULE_IDS = ['intro', 's2', 'a1', 's3', 'a2', 's4', 'a3', 's5', 'a4', 's6', 'a5'];
const TOTAL_MODULES = ALL_MODULE_IDS.length;

const MODULE_BUCKET_RANGES = {
  '0-3': [0, 3],
  '4-7': [4, 7],
  '8-10': [8, 10],
  '11': [11, 11],
};

const EXPORT_MAX_ROWS = 10000;

function parseStatusParam(raw) {
  if (raw == null || raw === '') return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .flatMap((p) => String(p).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

function statusToOverallPercentCondition(status) {
  if (status === 'completed') return { overallPercent: 100 };
  if (status === 'in_progress') return { overallPercent: { $gt: 0, $lt: 100 } };
  if (status === 'not_started') return { overallPercent: 0 };
  return null;
}

function parseDateStart(input) {
  const s = String(input).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00.000Z`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateEnd(input) {
  const s = String(input).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T23:59:59.999Z`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Builds MongoDB match for admin list/export. All conditions are ANDed.
 * Date boundaries use UTC for YYYY-MM-DD inputs (consistent with ISO storage).
 */
function buildWebinarAdminMatch(query) {
  const q = query || {};
  const and = [];
  const filterModeRaw = String(q.filterMode || 'first_join').trim().toLowerCase();
  const filterMode = filterModeRaw === 'last_activity' ? 'last_activity' : 'first_join';

  const search = (q.search || '').trim();
  if (search) {
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({ $or: [{ fullName: regex }, { phone: regex }] });
  }

  const statuses = parseStatusParam(q.status);
  if (statuses.length === 1) {
    const c = statusToOverallPercentCondition(statuses[0]);
    if (c) and.push(c);
  } else if (statuses.length > 1) {
    const parts = statuses.map(statusToOverallPercentCondition).filter(Boolean);
    if (parts.length) and.push({ $or: parts });
  }

  const progressMin = q.progressMin !== undefined && q.progressMin !== '' ? Number(q.progressMin) : NaN;
  const progressMax = q.progressMax !== undefined && q.progressMax !== '' ? Number(q.progressMax) : NaN;
  if (Number.isFinite(progressMin) || Number.isFinite(progressMax)) {
    const r = {};
    if (Number.isFinite(progressMin)) r.$gte = progressMin;
    if (Number.isFinite(progressMax)) r.$lte = progressMax;
    if (Object.keys(r).length) and.push({ overallPercent: r });
  }

  let minDate = null;
  let maxDate = null;
  const activeOn = (q.activeOn || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(activeOn)) {
    minDate = new Date(`${activeOn}T00:00:00.000Z`);
    maxDate = new Date(`${activeOn}T23:59:59.999Z`);
  }
  const firstJoinedFrom = (q.firstJoinedFrom || '').trim();
  const firstJoinedTo = (q.firstJoinedTo || '').trim();
  const fromRaw = firstJoinedFrom || (q.from || '').trim();
  const toRaw = firstJoinedTo || (q.to || '').trim();
  const fromD = fromRaw ? parseDateStart(fromRaw) : null;
  const toD = toRaw ? parseDateEnd(toRaw) : null;
  if (fromD) {
    minDate = minDate ? new Date(Math.max(minDate.getTime(), fromD.getTime())) : fromD;
  }
  if (toD) {
    maxDate = maxDate ? new Date(Math.min(maxDate.getTime(), toD.getTime())) : toD;
  }
  if (filterMode === 'first_join' && (minDate || maxDate)) {
    and.push({ isLegacyUser: false });
  }
  if (minDate && maxDate && minDate.getTime() > maxDate.getTime()) {
    and.push({ _id: { $exists: false } });
  } else {
    const dr = {};
    if (minDate) dr.$gte = minDate;
    if (maxDate) dr.$lte = maxDate;
    if (Object.keys(dr).length) {
      const dateField = filterMode === 'last_activity' ? 'lastActivityAt' : 'firstJoinedAt';
      and.push({ [dateField]: dr });
    }
  }

  const activity = (q.activity || '').trim();
  if (activity === 'active_5m') {
    and.push({ lastActivityAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } });
  } else if (activity === 'active_today') {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    and.push({ lastActivityAt: { $gte: start, $lte: end } });
  } else if (activity === 'inactive_24h') {
    and.push({ lastActivityAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
  }

  const bucket = (q.modulesBucket || '').trim();
  let modMin = NaN;
  let modMax = NaN;
  if (bucket && MODULE_BUCKET_RANGES[bucket]) {
    [modMin, modMax] = MODULE_BUCKET_RANGES[bucket];
  } else {
    if (q.modulesMin !== undefined && q.modulesMin !== '') modMin = Number(q.modulesMin);
    if (q.modulesMax !== undefined && q.modulesMax !== '') modMax = Number(q.modulesMax);
  }
  if (Number.isFinite(modMin) || Number.isFinite(modMax)) {
    const mm = Number.isFinite(modMin) ? modMin : 0;
    const mx = Number.isFinite(modMax) ? modMax : TOTAL_MODULES;
    and.push({
      $expr: {
        $and: [
          { $gte: [{ $size: { $ifNull: ['$completedModules', []] } }, mm] },
          { $lte: [{ $size: { $ifNull: ['$completedModules', []] } }, mx] },
        ],
      },
    });
  }

  const lam = (q.lastActiveModule || '').trim();
  if (lam && ALL_MODULE_IDS.includes(lam)) {
    and.push({ lastActiveModule: lam });
  }

  if (and.length === 0) return {};
  if (and.length === 1) return and[0];
  return { $and: and };
}

function parseSortParam(sortStr) {
  const raw = (sortStr || '-lastActivityAt').trim();
  const dir = raw.startsWith('-') ? -1 : 1;
  const field = raw.startsWith('-') ? raw.slice(1) : raw;
  const allowed = ['lastActivityAt', 'overallPercent', 'modulesDone'];
  if (!allowed.includes(field)) return { lastActivityAt: -1 };
  return { [field]: dir };
}

/**
 * Applies complete_all or reset bulk action. Shared by PATCH single-user and POST bulk.
 */
async function applyBulkProgressToPhone(phone, bulkAction, ProgressModel) {
  const Model = ProgressModel || WebinarProgress;
  const now = new Date();
  const existing = await Model.findOne({ phone }).lean();
  const completed = new Set(existing?.completedModules || []);
  const $set = { lastActivityAt: now };

  if (bulkAction === 'complete_all') {
    for (const id of ALL_MODULE_IDS) {
      completed.add(id);
      $set[`modules.${id}.status`] = 'completed';
      $set[`modules.${id}.progressPercent`] = 100;
      $set[`modules.${id}.completedAt`] = now;
      $set[`modules.${id}.unlockedAt`] = now;
    }
  } else if (bulkAction === 'reset') {
    completed.clear();
    for (const id of ALL_MODULE_IDS) {
      $set[`modules.${id}.status`] = id === 'intro' ? 'unlocked' : 'locked';
      $set[`modules.${id}.progressPercent`] = 0;
      $set[`modules.${id}.completedAt`] = null;
      $set[`modules.${id}.unlockedAt`] = id === 'intro' ? now : null;
      $set[`modules.${id}.watchedSeconds`] = 0;
      $set[`modules.${id}.maxWatchedSeconds`] = 0;
      $set[`modules.${id}.score`] = null;
      $set[`modules.${id}.totalScore`] = null;
    }
  } else {
    return { error: 'Invalid bulk action.' };
  }

  const completedArr = Array.from(completed);
  $set.completedModules = completedArr;
  $set.overallPercent = Math.round((completedArr.length / ALL_MODULE_IDS.length) * 100);

  const updated = await Model.findOneAndUpdate(
    { phone },
    { $set },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return { data: updated };
}

/** Display titles aligned with frontend mockWebinarData (for lastActivityEvent.moduleTitle). */
const MODULE_TITLES = {
  intro: 'Introduction to GuideXpert Counsellor training program',
  s2: 'Introduction to GuideXpert Counselling & Core Principles',
  a1: 'Assessment 1',
  s3: 'Mastering Counselling: Objection Handling & Communication Skills',
  a2: 'Assessment 2',
  s4: 'Lead Generation Methods & Strategies for Career Counsellors',
  a3: 'Assessment 3',
  s5: 'How to Position Yourself as a Trusted Career Counsellor',
  a4: 'Assessment 4',
  s6: 'GuideXpert Portal, Tools & Referral Process',
  a5: 'Assessment 5',
};

function isAssessmentModuleId(id) {
  return typeof id === 'string' && /^a\d+$/.test(id);
}

function pickPreferredModuleId(candidates, lastActiveModule) {
  if (!candidates.length) return null;
  if (typeof lastActiveModule === 'string' && candidates.includes(lastActiveModule)) return lastActiveModule;
  let best = candidates[0];
  let bestIdx = ALL_MODULE_IDS.indexOf(best);
  for (let i = 1; i < candidates.length; i += 1) {
    const id = candidates[i];
    const idx = ALL_MODULE_IDS.indexOf(id);
    if (idx > bestIdx) {
      best = id;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Infer a compact last activity snapshot from the sync body.
 * Priority: assessment completed → session/video completed → in-progress video → active module focus → generic.
 */
function deriveLastActivityEvent({ completedModules, modules, lastActiveModule, now }) {
  const at = now;
  const title = (id) => (id && MODULE_TITLES[id]) || id || 'Module';

  if (modules && typeof modules === 'object') {
    const completedIds = Object.entries(modules)
      .filter(([, mod]) => mod && mod.status === 'completed')
      .map(([id]) => id);

    const assessmentDone = completedIds.filter(isAssessmentModuleId);
    const sessionDone = completedIds.filter((id) => !isAssessmentModuleId(id));

    if (assessmentDone.length) {
      const id = pickPreferredModuleId(assessmentDone, lastActiveModule);
      return {
        type: 'assessment_completed',
        moduleId: id,
        moduleTitle: title(id),
        progressPercent: 100,
        watchedSeconds: null,
        at,
      };
    }
    if (sessionDone.length) {
      const id = pickPreferredModuleId(sessionDone, lastActiveModule);
      return {
        type: 'video_completed',
        moduleId: id,
        moduleTitle: title(id),
        progressPercent: 100,
        watchedSeconds: null,
        at,
      };
    }

    for (const id of ALL_MODULE_IDS) {
      const mod = modules[id];
      if (!mod || mod.status !== 'in_progress') continue;
      if (isAssessmentModuleId(id)) continue;
      const ws = typeof mod.watchedSeconds === 'number' ? mod.watchedSeconds : 0;
      const pp = typeof mod.progressPercent === 'number' ? mod.progressPercent : 0;
      if (ws > 0 || pp > 0) {
        return {
          type: 'video_progress',
          moduleId: id,
          moduleTitle: title(id),
          watchedSeconds: ws,
          progressPercent: Math.round(pp),
          at,
        };
      }
    }
  }

  if (typeof lastActiveModule === 'string' && ALL_MODULE_IDS.includes(lastActiveModule)) {
    return {
      type: 'module_unlocked',
      moduleId: lastActiveModule,
      moduleTitle: title(lastActiveModule),
      watchedSeconds: null,
      progressPercent: null,
      at,
    };
  }

  const fallbackId =
    Array.isArray(completedModules) && completedModules.length
      ? pickPreferredModuleId(completedModules.filter((id) => ALL_MODULE_IDS.includes(id)), lastActiveModule)
      : null;

  return {
    type: 'resume_seek',
    moduleId: fallbackId,
    moduleTitle: fallbackId ? title(fallbackId) : 'Training',
    watchedSeconds: null,
    progressPercent: null,
    at,
  };
}

function statusRankExpr(fieldPath) {
  return {
    $switch: {
      branches: [
        { case: { $eq: [fieldPath, 'completed'] }, then: 3 },
        { case: { $eq: [fieldPath, 'in_progress'] }, then: 2 },
        { case: { $eq: [fieldPath, 'unlocked'] }, then: 1 },
      ],
      default: 0,
    },
  };
}

// POST /api/webinar-progress/sync
// Uses an aggregation-pipeline update so every merge operation happens
// atomically inside MongoDB -- no read-then-write race.
async function syncProgress(req, res) {
  try {
    const user = await getWebinarUserFromToken(req);
    if (!user.phone) {
      const { status, body } = webinarAuthErrorResponse(user);
      return res.status(status).json(body);
    }

    const { completedModules, modules, lastActiveModule } = req.body || {};
    const now = new Date();
    const lastActivityEvent = deriveLastActivityEvent({
      completedModules,
      modules,
      lastActiveModule,
      now,
    });

    const existingFirstJoinedAt = { $ifNull: ['$firstJoinedAt', null] };
    const existingCreatedAt = { $ifNull: ['$createdAt', null] };
    const stage1 = {
      fullName: user.fullName || '',
      firstJoinedAt: {
        $cond: {
          if: { $eq: [existingCreatedAt, null] },
          then: now,
          else: '$firstJoinedAt',
        },
      },
      isLegacyUser: {
        $cond: {
          if: { $ne: [existingFirstJoinedAt, null] },
          then: false,
          else: {
            $cond: {
              if: { $eq: [existingCreatedAt, null] },
              then: false,
              else: true,
            },
          },
        },
      },
      lastActivityAt: now,
      lastActivityEvent,
    };

    if (Array.isArray(completedModules)) {
      stage1.completedModules = {
        $setUnion: [{ $ifNull: ['$completedModules', []] }, completedModules],
      };
    }

    if (typeof lastActiveModule === 'string') {
      stage1.lastActiveModule = lastActiveModule;
    }

    if (modules && typeof modules === 'object') {
      for (const [moduleId, mod] of Object.entries(modules)) {
        if (!mod || typeof mod !== 'object') continue;
        const p = `modules.${moduleId}`;
        const curStatus = { $ifNull: [`$${p}.status`, 'locked'] };

        if (mod.status && STATUS_RANK[mod.status] != null) {
          const incoming = STATUS_RANK[mod.status];
          stage1[`${p}.status`] = {
            $cond: {
              if: { $gt: [incoming, statusRankExpr(curStatus)] },
              then: mod.status,
              else: curStatus,
            },
          };
        }

        if (typeof mod.progressPercent === 'number') {
          stage1[`${p}.progressPercent`] = {
            $max: [{ $ifNull: [`$${p}.progressPercent`, 0] }, mod.progressPercent],
          };
        }
        if (typeof mod.watchedSeconds === 'number') {
          stage1[`${p}.watchedSeconds`] = {
            $max: [{ $ifNull: [`$${p}.watchedSeconds`, 0] }, mod.watchedSeconds],
          };
        }
        if (typeof mod.maxWatchedSeconds === 'number') {
          stage1[`${p}.maxWatchedSeconds`] = {
            $max: [{ $ifNull: [`$${p}.maxWatchedSeconds`, 0] }, mod.maxWatchedSeconds],
          };
        }
        if (mod.completedAt) {
          stage1[`${p}.completedAt`] = {
            $ifNull: [`$${p}.completedAt`, new Date(mod.completedAt)],
          };
        }
        if (mod.unlockedAt) {
          stage1[`${p}.unlockedAt`] = {
            $ifNull: [`$${p}.unlockedAt`, new Date(mod.unlockedAt)],
          };
        }
      }
    }

    const pipeline = [{ $set: stage1 }];

    if (Array.isArray(completedModules)) {
      pipeline.push({
        $set: {
          overallPercent: {
            $round: [
              { $multiply: [{ $divide: [{ $size: { $ifNull: ['$completedModules', []] } }, TOTAL_MODULES] }, 100] },
              0,
            ],
          },
        },
      });
    }

    const updated = await WebinarProgress2627.findOneAndUpdate(
      { phone: user.phone },
      pipeline,
      { upsert: true, new: true, updatePipeline: true }
    ).lean();

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: updated });
  } catch (err) {
    console.error('[syncProgress]', err);
    return res.status(500).json({ success: false, message: 'Failed to sync progress.' });
  }
}

// GET /api/webinar-progress
async function getProgress(req, res) {
  try {
    const user = await getWebinarUserFromToken(req);
    if (!user.phone) {
      const { status, body } = webinarAuthErrorResponse(user);
      return res.status(status).json(body);
    }

    const doc = await WebinarProgress2627.findOne({ phone: user.phone }).lean();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    if (!doc) {
      return res.status(200).json({ success: true, data: null });
    }

    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    console.error('[getProgress]', err);
    return res.status(500).json({ success: false, message: 'Failed to get progress.' });
  }
}

// POST /api/webinar-progress/certificate-downloaded
async function recordCertificateDownload(req, res) {
  try {
    const user = await getWebinarUserFromToken(req);
    if (!user.phone) {
      const { status, body } = webinarAuthErrorResponse(user);
      return res.status(status).json(body);
    }

    await WebinarProgress2627.findOneAndUpdate(
      { phone: user.phone },
      { $set: { certificateDownloadedAt: new Date() } },
      { new: true, upsert: true }
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[recordCertificateDownload]', err);
    return res.status(500).json({ success: false, message: 'Failed to record certificate download.' });
  }
}

const LIST_PROJECTION = {
  phone: 1,
  fullName: 1,
  overallPercent: 1,
  completedModules: 1,
  lastActiveModule: 1,
  firstJoinedAt: 1,
  isLegacyUser: 1,
  lastActivityAt: 1,
  lastActivityEvent: 1,
  certificateDownloadedAt: 1,
};

// GET /api/admin/webinar-progress
async function adminListProgress(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(ADMIN_LIST_MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;
    const sort = (req.query.sort || '-lastActivityAt').trim();
    const match = buildWebinarAdminMatch(req.query);
    const sortSpec = parseSortParam(sort);

    const Model = progressModel(req);
    const [users, total] = await Promise.all([
      Model.aggregate([
        { $match: match },
        { $sort: sortSpec },
        { $skip: skip },
        { $limit: limit },
        { $project: { ...LIST_PROJECTION, modulesDone: { $size: { $ifNull: ['$completedModules', []] } } } },
      ]),
      Model.countDocuments(match),
    ]);

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({ success: true, data: { users, total, page, limit } });
  } catch (err) {
    console.error('[adminListProgress]', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch progress list.' });
  }
}

// GET /api/admin/webinar-progress/stats
async function adminProgressStats(req, res) {
  try {
    const Model = progressModel(req);
    const yearMatch = assessmentTrainingYearMatch(req);
    const assessmentIds = ['a1', 'a2', 'a3', 'a4', 'a5'];

    const [totalResult, completedResult, avgResult, activeResult, perModuleResult, highScorerResult, assessmentAggResult] = await Promise.all([
      Model.countDocuments(),
      Model.countDocuments({ overallPercent: 100 }),
      Model.aggregate([{ $group: { _id: null, avg: { $avg: '$overallPercent' } } }]),
      Model.countDocuments({ lastActivityAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
      Model.aggregate([
        { $unwind: '$completedModules' },
        { $group: { _id: '$completedModules', count: { $sum: 1 } } },
      ]),
      WebinarAssessmentSubmission.aggregate([
        { $match: { ...yearMatch, assessmentId: { $in: assessmentIds } } },
        { $addFields: { pct: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$score', '$total'] }, 0] } } },
        { $match: { pct: { $gte: 0.8 } } },
        { $group: { _id: { assessmentId: '$assessmentId', phone: '$phone' } } },
        { $group: { _id: '$_id.assessmentId', count: { $sum: 1 } } },
      ]),
      WebinarAssessmentSubmission.aggregate([
        { $match: { ...yearMatch, assessmentId: { $in: assessmentIds }, total: { $gt: 0 } } },
        { $addFields: { pct: { $divide: ['$score', '$total'] } } },
        {
          $group: {
            _id: { assessmentId: '$assessmentId', phone: '$phone' },
            bestPct: { $max: '$pct' },
            bestScore: { $max: '$score' },
            bestTotal: { $first: '$total' },
            attempts: { $sum: 1 },
            avgPct: { $avg: '$pct' },
            isPerfect: { $max: { $cond: [{ $eq: ['$score', '$total'] }, 1, 0] } },
          },
        },
        {
          $group: {
            _id: '$_id.assessmentId',
            avgScorePct: { $avg: '$bestPct' },
            highestScorePct: { $max: '$bestPct' },
            totalAttempts: { $sum: '$attempts' },
            uniqueAttempters: { $sum: 1 },
            perfectScorers: { $sum: '$isPerfect' },
            highScorers: { $sum: { $cond: [{ $gte: ['$bestPct', 0.8] }, 1, 0] } },
            lowScorers: { $sum: { $cond: [{ $lt: ['$bestPct', 0.5] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const perModule = {};
    for (const item of perModuleResult) {
      perModule[item._id] = item.count;
    }

    const perModuleHighScorers = {};
    for (const item of highScorerResult) {
      perModuleHighScorers[item._id] = item.count;
    }

    const assessmentAnalytics = {};
    for (const item of assessmentAggResult) {
      assessmentAnalytics[item._id] = {
        avgScorePct: Math.round((item.avgScorePct || 0) * 1000) / 10,
        highestScorePct: Math.round((item.highestScorePct || 0) * 1000) / 10,
        totalAttempts: item.totalAttempts || 0,
        uniqueAttempters: item.uniqueAttempters || 0,
        perfectScorers: item.perfectScorers || 0,
        highScorers: item.highScorers || 0,
        lowScorers: item.lowScorers || 0,
      };
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({
      success: true,
      data: {
        totalEnrolled: totalResult,
        fullyCompleted: completedResult,
        averagePercent: Math.round((avgResult[0]?.avg || 0) * 10) / 10,
        activeLast24h: activeResult,
        perModuleCompletion: perModule,
        perModuleHighScorers,
        assessmentAnalytics,
      },
    });
  } catch (err) {
    console.error('[adminProgressStats]', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
}

// GET /api/admin/webinar-progress/:phone
async function adminProgressDetail(req, res) {
  try {
    const phone = (req.params.phone || '').trim();
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number.' });
    }

    const doc = await progressModel(req).findOne({ phone }).lean();
    if (!doc) {
      return res.status(404).json({ success: false, message: 'No progress found for this user.' });
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    console.error('[adminProgressDetail]', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch user progress.' });
  }
}

// GET /api/admin/webinar-progress/:phone/assessments
async function adminAssessmentDetail(req, res) {
  try {
    const phone = (req.params.phone || '').trim();
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number.' });
    }

    const submissions = await WebinarAssessmentSubmission.find({
      phone,
      ...assessmentTrainingYearMatch(req),
    })
      .sort({ submittedAt: -1 })
      .lean();

    const grouped = {};
    for (const sub of submissions) {
      if (!grouped[sub.assessmentId]) grouped[sub.assessmentId] = [];
      grouped[sub.assessmentId].push(sub);
    }

    const assessments = Object.entries(grouped).map(([assessmentId, attempts]) => {
      const best = attempts.reduce((a, b) => (a.score > b.score ? a : b), attempts[0]);
      const latest = attempts[0];
      const accuracy = best.total > 0 ? Math.round((best.score / best.total) * 1000) / 10 : 0;

      return {
        assessmentId,
        attemptCount: attempts.length,
        bestScore: best.score,
        bestTotal: best.total,
        accuracy,
        latestScore: latest.score,
        latestTotal: latest.total,
        lastAttemptedAt: latest.submittedAt,
        attempts: attempts.map((a) => ({
          _id: a._id,
          score: a.score,
          total: a.total,
          accuracy: a.total > 0 ? Math.round((a.score / a.total) * 1000) / 10 : 0,
          submittedAt: a.submittedAt,
          results: a.results || [],
        })),
      };
    });

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    return res.status(200).json({ success: true, data: { phone, assessments } });
  } catch (err) {
    console.error('[adminAssessmentDetail]', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch assessment details.' });
  }
}

// POST /api/admin/webinar-progress/bulk
async function adminBulkProgress(req, res) {
  try {
    const { phones, action } = req.body || {};
    if (!Array.isArray(phones) || phones.length === 0) {
      return res.status(400).json({ success: false, message: 'Provide a non-empty phones array.' });
    }
    if (!['reset', 'complete_all'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action.' });
    }
    if (phones.length > 100) {
      return res.status(400).json({ success: false, message: 'Maximum 100 phones per request.' });
    }

    const Model = progressModel(req);
    const results = [];
    for (const raw of phones) {
      const phone = String(raw || '').replace(/\D/g, '').slice(-10);
      if (!/^\d{10}$/.test(phone)) continue;
      const out = await applyBulkProgressToPhone(phone, action, Model);
      if (out.error) {
        return res.status(400).json({ success: false, message: out.error });
      }
      results.push(out.data);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: { updated: results.length, users: results } });
  } catch (err) {
    console.error('[adminBulkProgress]', err);
    return res.status(500).json({ success: false, message: 'Failed bulk update.' });
  }
}

// PATCH /api/admin/webinar-progress/:phone
async function adminUpdateProgress(req, res) {
  try {
    const phone = (req.params.phone || '').trim();
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number.' });
    }

    const { moduleUpdates, bulkAction } = req.body || {};
    const now = new Date();
    const Model = progressModel(req);

    if (bulkAction === 'complete_all' || bulkAction === 'reset') {
      const out = await applyBulkProgressToPhone(phone, bulkAction, Model);
      if (out.error) {
        return res.status(400).json({ success: false, message: out.error });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ success: true, data: out.data });
    }

    const existing = await Model.findOne({ phone }).lean();
    const completed = new Set(existing?.completedModules || []);
    const $set = { lastActivityAt: now };

    if (moduleUpdates && typeof moduleUpdates === 'object') {
      for (const [moduleId, action] of Object.entries(moduleUpdates)) {
        if (!ALL_MODULE_IDS.includes(moduleId)) continue;

        if (action === 'complete') {
          completed.add(moduleId);
          $set[`modules.${moduleId}.status`] = 'completed';
          $set[`modules.${moduleId}.progressPercent`] = 100;
          $set[`modules.${moduleId}.completedAt`] = now;
          const prev = existing?.modules?.[moduleId];
          $set[`modules.${moduleId}.unlockedAt`] = prev?.unlockedAt || now;
        } else if (action === 'uncomplete') {
          completed.delete(moduleId);
          $set[`modules.${moduleId}.status`] = 'unlocked';
          $set[`modules.${moduleId}.progressPercent`] = 0;
          $set[`modules.${moduleId}.completedAt`] = null;
        }
      }
    } else {
      return res.status(400).json({ success: false, message: 'Provide moduleUpdates or bulkAction.' });
    }

    const completedArr = Array.from(completed);
    $set.completedModules = completedArr;
    $set.overallPercent = Math.round((completedArr.length / ALL_MODULE_IDS.length) * 100);

    const updated = await Model.findOneAndUpdate(
      { phone },
      { $set },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: updated });
  } catch (err) {
    console.error('[adminUpdateProgress]', err);
    return res.status(500).json({ success: false, message: 'Failed to update progress.' });
  }
}

// GET /api/admin/webinar-progress/export
async function adminProgressExport(req, res) {
  try {
    const match = buildWebinarAdminMatch(req.query);
    const pipeline = [
      { $match: match },
      {
        $addFields: {
          modulesDone: { $size: { $ifNull: ['$completedModules', []] } },
        },
      },
      { $sort: { lastActivityAt: -1 } },
      { $limit: EXPORT_MAX_ROWS + 1 },
    ];

    const docs = await progressModel(req).aggregate(pipeline);
    if (docs.length > EXPORT_MAX_ROWS) {
      return res.status(413).json({
        success: false,
        message: `Export limited to ${EXPORT_MAX_ROWS} rows. Narrow your filters.`,
      });
    }

    const header =
      'Name,Phone,Overall %,Status,Join Type,Modules Done,First Joined,Completed Modules,Last Active Module,Last Activity\n';
    const rows = docs.map((d) => {
      const name = (d.fullName || '').replace(/,/g, ' ');
      const completed = (d.completedModules || []).join('; ');
      const firstJoined = d.firstJoinedAt ? new Date(d.firstJoinedAt).toISOString() : '';
      const lastActive = d.lastActivityAt ? new Date(d.lastActivityAt).toISOString() : '';
      const pct = d.overallPercent ?? 0;
      const status =
        pct >= 100 ? 'completed' : pct > 0 ? 'in_progress' : 'not_started';
      const joinType = d.isLegacyUser ? 'legacy' : 'new';
      const modDone = d.modulesDone != null ? d.modulesDone : (d.completedModules || []).length;
      return `${name},${d.phone},${pct},"${status}",${joinType},${modDone},${firstJoined},"${completed}",${d.lastActiveModule || ''},${lastActive}`;
    });

    const csv = header + rows.join('\n');
    const cohort = req.webinarAssessmentCohort === '26-27' ? '26-27' : '25-26';
    const filename = `training-progress-${cohort}-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[adminProgressExport]', err);
    return res.status(500).json({ success: false, message: 'Failed to export.' });
  }
}

module.exports = {
  bindWebinarProgressCohort,
  syncProgress,
  getProgress,
  recordCertificateDownload,
  adminListProgress,
  adminProgressStats,
  adminProgressDetail,
  adminAssessmentDetail,
  adminUpdateProgress,
  adminBulkProgress,
  adminProgressExport,
};
