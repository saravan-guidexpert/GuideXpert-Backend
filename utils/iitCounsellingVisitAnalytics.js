'use strict';

const { retryTransient, analyticsFailurePayload, logDbError } = require('./mongoRetry');

/**
 * IIT counselling visit analytics.
 *
 * The previous pipelines $addToSet every visitorFingerprint (sha256 hex, 64 chars)
 * into the result document, including three copies on the UTM summary and one copy
 * per trend bucket. A few tens of thousands of distinct visitors exceed MongoDB's
 * 16MB BSON document limit. The server then fails the command with
 * "BSON size limit hit while building Message". The admin UI only needs counts,
 * so these pipelines count distinct fingerprints with a second $group and never
 * put the fingerprint list on the wire.
 *
 * The leading $match is `{ pageKey, visitedAt? }`. IitCounsellingVisit already
 * declares `{ pageKey: 1, visitedAt: -1 }`, which supports that predicate.
 * No new index is required for this shape. All-time totals are unchanged when
 * the caller omits a date range.
 */
const VISIT_ANALYTICS_INDEX = Object.freeze({ pageKey: 1, visitedAt: -1 });

/** Stay under the 45s socket timeout and the 60s Vercel function limit. */
const ANALYTICS_MAX_TIME_MS = 20000;

const TREND_TIMEZONE = 'Asia/Kolkata';

function iitCounsellingVisitHasAnyUtmExpression() {
  return {
    $or: [
      { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ['$utm_source', ''] } } } }, 0] },
      { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ['$utm_medium', ''] } } } }, 0] },
      { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ['$utm_campaign', ''] } } } }, 0] },
      { $gt: [{ $strLenCP: { $trim: { input: { $ifNull: ['$utm_content', ''] } } } }, 0] },
    ],
  };
}

function iitCounsellingUtmNormExpr(field) {
  return {
    $let: {
      vars: { raw: { $trim: { input: { $ifNull: [`$${field}`, ''] } } } },
      in: {
        $cond: [{ $eq: [{ $strLenCP: '$$raw' }, 0] }, '(none)', '$$raw'],
      },
    },
  };
}

function buildVisitMatch(pageKey, dateTime) {
  const match = { pageKey };
  if (dateTime?.hasRange && dateTime.visitedAt) {
    match.visitedAt = dateTime.visitedAt;
  }
  return match;
}

function dimensionStages(field, labelKey, linkedIdField) {
  return [
    { $addFields: { _dimNorm: iitCounsellingUtmNormExpr(field) } },
    {
      $group: {
        _id: { dim: '$_dimNorm', fp: '$visitorFingerprint' },
        visits: { $sum: 1 },
        linkedSubmissions: {
          $sum: { $cond: [{ $ne: [`$${linkedIdField}`, null] }, 1, 0] },
        },
      },
    },
    {
      $group: {
        _id: '$_id.dim',
        visits: { $sum: '$visits' },
        uniqueVisitors: { $sum: 1 },
        linkedSubmissions: { $sum: '$linkedSubmissions' },
      },
    },
    { $sort: { visits: -1 } },
    { $limit: 15 },
    {
      $project: {
        _id: 0,
        [labelKey]: '$_id',
        visits: 1,
        uniqueVisitors: 1,
        linkedSubmissions: 1,
      },
    },
  ];
}

function buildVisitAnalyticsPipeline(match, granularity) {
  const trendDateFormat = granularity === 'hourly' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
  return [
    { $match: match },
    {
      $project: {
        visitorFingerprint: 1,
        visitedAt: 1,
        referrer: 1,
        utm_source: 1,
        utm_campaign: 1,
      },
    },
    {
      $facet: {
        totals: [
          { $group: { _id: '$visitorFingerprint', visits: { $sum: 1 } } },
          {
            $group: {
              _id: null,
              totalVisits: { $sum: '$visits' },
              uniqueVisitors: { $sum: 1 },
            },
          },
        ],
        trend: [
          {
            $group: {
              _id: {
                bucket: {
                  $dateToString: {
                    format: trendDateFormat,
                    date: '$visitedAt',
                    timezone: TREND_TIMEZONE,
                  },
                },
                fp: '$visitorFingerprint',
              },
              totalVisits: { $sum: 1 },
            },
          },
          {
            $group: {
              _id: '$_id.bucket',
              totalVisits: { $sum: '$totalVisits' },
              uniqueVisitors: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ],
        topReferrers: [
          { $match: { referrer: { $exists: true, $nin: ['', null] } } },
          { $group: { _id: '$referrer', visits: { $sum: 1 } } },
          { $sort: { visits: -1 } },
          { $limit: 500 },
        ],
        topUtmSources: [
          { $match: { utm_source: { $exists: true, $nin: ['', null] } } },
          { $group: { _id: '$utm_source', visits: { $sum: 1 } } },
          { $sort: { visits: -1 } },
          { $limit: 500 },
        ],
        topCampaigns: [
          { $match: { utm_campaign: { $exists: true, $nin: ['', null] } } },
          { $group: { _id: '$utm_campaign', visits: { $sum: 1 } } },
          { $sort: { visits: -1 } },
          { $limit: 500 },
        ],
      },
    },
  ];
}

function buildUtmAnalyticsPipeline(match, linkedIdField) {
  const hasAny = iitCounsellingVisitHasAnyUtmExpression();
  return [
    { $match: match },
    {
      $project: {
        visitorFingerprint: 1,
        visitedAt: 1,
        utm_source: 1,
        utm_medium: 1,
        utm_campaign: 1,
        utm_content: 1,
        [linkedIdField]: 1,
      },
    },
    {
      $facet: {
        summary: [
          {
            $group: {
              _id: '$visitorFingerprint',
              visits: { $sum: 1 },
              visitsWithUtm: { $sum: { $cond: [hasAny, 1, 0] } },
              visitsWithoutUtm: { $sum: { $cond: [hasAny, 0, 1] } },
            },
          },
          {
            $group: {
              _id: null,
              totalVisits: { $sum: '$visits' },
              visitsWithAnyUtm: { $sum: '$visitsWithUtm' },
              uniqueVisitors: { $sum: 1 },
              uniqueVisitorsWithUtm: {
                $sum: { $cond: [{ $gt: ['$visitsWithUtm', 0] }, 1, 0] },
              },
              uniqueVisitorsWithoutUtm: {
                $sum: { $cond: [{ $gt: ['$visitsWithoutUtm', 0] }, 1, 0] },
              },
            },
          },
          {
            $project: {
              _id: 0,
              totalVisits: 1,
              visitsWithAnyUtm: 1,
              visitsWithoutUtm: { $subtract: ['$totalVisits', '$visitsWithAnyUtm'] },
              uniqueVisitors: 1,
              uniqueVisitorsWithUtm: 1,
              uniqueVisitorsWithoutUtm: 1,
            },
          },
        ],
        bySource: dimensionStages('utm_source', 'utm_source', linkedIdField),
        byMedium: dimensionStages('utm_medium', 'utm_medium', linkedIdField),
        byCampaign: dimensionStages('utm_campaign', 'utm_campaign', linkedIdField),
        byContent: dimensionStages('utm_content', 'utm_content', linkedIdField),
        byCombo: [
          {
            $addFields: {
              utm_source_n: iitCounsellingUtmNormExpr('utm_source'),
              utm_medium_n: iitCounsellingUtmNormExpr('utm_medium'),
              utm_campaign_n: iitCounsellingUtmNormExpr('utm_campaign'),
              utm_content_n: iitCounsellingUtmNormExpr('utm_content'),
            },
          },
          {
            $group: {
              _id: {
                utm_source: '$utm_source_n',
                utm_medium: '$utm_medium_n',
                utm_campaign: '$utm_campaign_n',
                utm_content: '$utm_content_n',
                fp: '$visitorFingerprint',
              },
              visits: { $sum: 1 },
              linkedSubmissions: {
                $sum: { $cond: [{ $ne: [`$${linkedIdField}`, null] }, 1, 0] },
              },
              firstVisitAt: { $min: '$visitedAt' },
              latestVisitAt: { $max: '$visitedAt' },
            },
          },
          {
            $group: {
              _id: {
                utm_source: '$_id.utm_source',
                utm_medium: '$_id.utm_medium',
                utm_campaign: '$_id.utm_campaign',
                utm_content: '$_id.utm_content',
              },
              visits: { $sum: '$visits' },
              uniqueVisitors: { $sum: 1 },
              linkedSubmissions: { $sum: '$linkedSubmissions' },
              firstVisitAt: { $min: '$firstVisitAt' },
              latestVisitAt: { $max: '$latestVisitAt' },
            },
          },
          { $sort: { latestVisitAt: -1 } },
          { $limit: 500 },
          {
            $project: {
              _id: 0,
              utm_source: '$_id.utm_source',
              utm_medium: '$_id.utm_medium',
              utm_campaign: '$_id.utm_campaign',
              utm_content: '$_id.utm_content',
              visits: 1,
              uniqueVisitors: 1,
              linkedSubmissions: 1,
              firstVisitAt: 1,
              latestVisitAt: 1,
            },
          },
        ],
      },
    },
  ];
}

function shapeVisitAnalytics(facet = {}, { dateTime, pageKey, totalSubmissions }) {
  const totals = facet.totals?.[0] || { totalVisits: 0, uniqueVisitors: 0 };
  const totalVisits = totals.totalVisits || 0;
  const uniqueVisitors = totals.uniqueVisitors || 0;
  return {
    totalVisits,
    uniqueVisitors,
    totalSubmissions,
    conversionRate: totalVisits > 0 ? Number(((totalSubmissions / totalVisits) * 100).toFixed(2)) : 0,
    granularity: dateTime.granularity,
    trend: (facet.trend || []).map((row) => ({
      bucket: row._id,
      totalVisits: row.totalVisits,
      uniqueVisitors: row.uniqueVisitors || 0,
    })),
    filters: {
      fromDate: dateTime.fromDate,
      toDate: dateTime.toDate,
      fromTime: dateTime.fromTime,
      toTime: dateTime.toTime,
      granularity: dateTime.granularity,
      linkTarget: pageKey,
    },
    topReferrers: (facet.topReferrers || []).map((row) => ({ referrer: row._id, visits: row.visits })),
    topUtmSources: (facet.topUtmSources || []).map((row) => ({ source: row._id, visits: row.visits })),
    topCampaigns: (facet.topCampaigns || []).map((row) => ({ campaign: row._id, visits: row.visits })),
  };
}

function readUtmFacet(facet = {}) {
  return {
    summary: facet.summary?.[0] || {
      totalVisits: 0,
      visitsWithAnyUtm: 0,
      visitsWithoutUtm: 0,
      uniqueVisitors: 0,
      uniqueVisitorsWithUtm: 0,
      uniqueVisitorsWithoutUtm: 0,
    },
    bySource: facet.bySource || [],
    byMedium: facet.byMedium || [],
    byCampaign: facet.byCampaign || [],
    byContent: facet.byContent || [],
    byCombo: facet.byCombo || [],
  };
}

async function runAnalyticsAggregate(model, pipeline, comment) {
  return retryTransient(
    () => model.aggregate(pipeline).allowDiskUse(true).option({
      maxTimeMS: ANALYTICS_MAX_TIME_MS,
      comment,
    }),
    { attempts: 2, baseDelayMs: 250, maxDelayMs: 1000, idempotent: true }
  );
}

module.exports = {
  VISIT_ANALYTICS_INDEX,
  ANALYTICS_MAX_TIME_MS,
  iitCounsellingVisitHasAnyUtmExpression,
  iitCounsellingUtmNormExpr,
  buildVisitMatch,
  buildVisitAnalyticsPipeline,
  buildUtmAnalyticsPipeline,
  shapeVisitAnalytics,
  readUtmFacet,
  runAnalyticsAggregate,
  analyticsFailurePayload,
  logDbError,
};
