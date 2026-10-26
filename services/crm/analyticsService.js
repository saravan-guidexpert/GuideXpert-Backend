'use strict';

const CrmReferral = require('../../models/CrmReferral');
const CrmConsultancy = require('../../models/CrmConsultancy');
const { ADMISSION_STATUSES } = require('../../constants/crm');
const { parsePageLimit } = require('../../utils/crmHttp');
const {
  resolveAnalyticsRange,
  resolveCalendarRange,
  previousBounds,
  eachDateKey,
  monthWindow,
  dayLabel,
  monthLabel,
} = require('../../utils/crmRange');
const { pageReferrals } = require('./referralService');
const { assignedConsultancyIds } = require('./crmAccess');

const KNOWN_EXCEPT_OPEN = ADMISSION_STATUSES.filter((status) => status !== 'Not started');

function statusExpression() {
  return {
    $switch: {
      branches: KNOWN_EXCEPT_OPEN.map((status) => ({
        case: { $eq: ['$student.admissionStatus', status] },
        then: status,
      })),
      default: 'Not started',
    },
  };
}

function studentLookup() {
  return [
    {
      $lookup: {
        from: 'crmStudents',
        localField: 'crmStudentId',
        foreignField: '_id',
        as: 'student',
      },
    },
    { $unwind: { path: '$student', preserveNullAndEmptyArrays: true } },
    { $addFields: { admissionStatus: statusExpression() } },
  ];
}

function rangeMatch(range) {
  if (!range || !range.start || !range.end) {
    return { referredAt: { $type: 'date' } };
  }
  return { referredAt: { $gte: range.start, $lte: range.end } };
}

function rate(part, whole) {
  if (!whole) return { part, whole, rate: null, label: 'No base' };
  const value = part / whole;
  return { part, whole, rate: value, label: `${Math.round(value * 100)}%` };
}

function fillCounts(keys, grouped, labelFor) {
  const counts = new Map(grouped.map((row) => [row._id, row.count]));
  return keys.map((key) => ({
    key,
    label: labelFor(key),
    count: counts.get(key) || 0,
  }));
}

async function groupByFormat(match, format, timeZone) {
  return CrmReferral.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          $dateToString: { format, date: '$referredAt', timezone: timeZone },
        },
        count: { $sum: 1 },
      },
    },
  ]);
}

async function volumeFor(range, match) {
  const scoped = match || rangeMatch(range);
  if (range.grain === 'day' && range.from && range.to) {
    const grouped = await groupByFormat(scoped, '%Y-%m-%d', range.timeZone);
    return {
      grain: 'day',
      truncated: false,
      points: fillCounts(eachDateKey(range.from, range.to), grouped, dayLabel),
    };
  }
  const grouped = await groupByFormat(scoped, '%Y-%m', range.timeZone);
  if (!range.from || !range.to) {
    const present = grouped.map((row) => row._id).filter(Boolean).sort();
    if (present.length === 0) return { grain: 'month', truncated: false, points: [] };
    const window = monthWindow(present[0], present[present.length - 1]);
    return { grain: 'month', truncated: window.truncated, points: fillCounts(window.months, grouped, monthLabel) };
  }
  const window = monthWindow(range.from.slice(0, 7), range.to.slice(0, 7));
  return { grain: 'month', truncated: window.truncated, points: fillCounts(window.months, grouped, monthLabel) };
}

async function statusCounts(match) {
  const rows = await CrmReferral.aggregate([
    { $match: match },
    ...studentLookup(),
    { $group: { _id: '$admissionStatus', count: { $sum: 1 } } },
  ]);
  const counts = new Map(rows.map((row) => [row._id, row.count]));
  return ADMISSION_STATUSES.map((status) => ({
    status,
    count: counts.get(status) || 0,
  }));
}

function conversionFrom(distribution) {
  const count = (names) => distribution
    .filter((row) => names.includes(row.status))
    .reduce((sum, row) => sum + row.count, 0);
  const whole = distribution.reduce((sum, row) => sum + row.count, 0);
  const applied = count(['Applied', 'Admitted', 'Enrolled']);
  const admitted = count(['Admitted', 'Enrolled']);
  const enrolled = count(['Enrolled']);
  return {
    referralToApplication: rate(applied, whole),
    applicationToAdmission: rate(admitted, applied),
    admissionToEnrollment: rate(enrolled, admitted),
  };
}

async function rankConsultancies(match) {
  const rows = await CrmReferral.aggregate([
    { $match: match },
    ...studentLookup(),
    {
      $group: {
        _id: '$consultancyId',
        referrals: { $sum: 1 },
        admitted: {
          $sum: {
            $cond: [{ $in: ['$admissionStatus', ['Admitted', 'Enrolled']] }, 1, 0],
          },
        },
        enrolled: {
          $sum: { $cond: [{ $eq: ['$admissionStatus', 'Enrolled'] }, 1, 0] },
        },
        nameSnapshot: { $first: '$consultancyNameSnapshot' },
      },
    },
  ]);
  const ids = rows.map((row) => row._id);
  const consultancies = await CrmConsultancy.find({ _id: { $in: ids }, deletedAt: null })
    .select('name status')
    .lean();
  const byId = new Map(consultancies.map((row) => [String(row._id), row]));
  return rows
    .filter((row) => byId.has(String(row._id)))
    .map((row) => {
      const consultancy = byId.get(String(row._id));
      return {
        id: String(row._id),
        name: consultancy.name || row.nameSnapshot,
        status: consultancy.status,
        referrals: row.referrals,
        admitted: row.admitted,
        enrolled: row.enrolled,
      };
    })
    .sort((a, b) => b.enrolled - a.enrolled || b.admitted - a.admitted || b.referrals - a.referrals || a.name.localeCompare(b.name));
}

async function getAnalytics(query, now = new Date(), actor) {
  const range = resolveAnalyticsRange(query, now);
  const match = rangeMatch(range);
  const allowed = await assignedConsultancyIds(actor);
  if (allowed) match.consultancyId = { $in: allowed };
  const previous = previousBounds(range);
  const consultancyFilter = allowed
    ? { _id: { $in: allowed }, deletedAt: null, status: 'active' }
    : { deletedAt: null, status: 'active' };
  const undatedFilter = { $or: [{ referredAt: null }, { referredAt: { $exists: false } }] };
  if (allowed) undatedFilter.consultancyId = { $in: allowed };
  const previousFilter = previous
    ? { referredAt: { $gte: previous.start, $lte: previous.end } }
    : null;
  if (previousFilter && allowed) previousFilter.consultancyId = { $in: allowed };
  const [distribution, volume, ranking, activeConsultancies, undatedReferrals, previousPeriodReferrals] = await Promise.all([
    statusCounts(match),
    volumeFor(range, match),
    rankConsultancies(match),
    CrmConsultancy.countDocuments(consultancyFilter),
    CrmReferral.countDocuments(undatedFilter),
    previousFilter ? CrmReferral.countDocuments(previousFilter) : Promise.resolve(null),
  ]);
  const referralsInPeriod = distribution.reduce((sum, row) => sum + row.count, 0);
  return {
    timeZone: range.timeZone,
    dateField: 'referredAt',
    basis: 'current_admission_status',
    basisLabel: 'Current admission status. Earlier statuses are not stored, so these are not historical conversion rates.',
    range: {
      id: range.id,
      label: range.label,
      from: range.from,
      to: range.to,
      start: range.start,
      end: range.end,
    },
    referralsInPeriod,
    previousPeriodReferrals,
    activeConsultancies,
    undatedReferrals,
    volume,
    statusDistribution: distribution,
    conversion: conversionFrom(distribution),
    ranking,
  };
}

async function getCalendar(query, actor) {
  const range = resolveCalendarRange(query);
  const { page, limit, skip } = parsePageLimit(query);
  const match = rangeMatch(range);
  const allowed = await assignedConsultancyIds(actor);
  if (allowed) match.consultancyId = { $in: allowed };
  const [grouped, pageResult] = await Promise.all([
    groupByFormat(match, '%Y-%m-%d', range.timeZone),
    pageReferrals(match, { page, limit, skip, sort: { referredAt: 1, _id: 1 } }),
  ]);
  return {
    timeZone: range.timeZone,
    dateField: 'referredAt',
    from: range.from,
    to: range.to,
    days: fillCounts(eachDateKey(range.from, range.to), grouped, dayLabel),
    ...pageResult,
  };
}

module.exports = {
  getAnalytics,
  getCalendar,
  referralVolume: volumeFor,
  statusCounts,
};
