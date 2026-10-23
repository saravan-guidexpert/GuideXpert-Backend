'use strict';

const fs = require('fs');
const path = require('path');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { calculateObjectSize } = require('bson');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const IitCounsellingVisit = require('../models/IitCounsellingVisit');
const {
  VISIT_ANALYTICS_INDEX,
  ANALYTICS_MAX_TIME_MS,
  buildVisitMatch,
  buildVisitAnalyticsPipeline,
  buildUtmAnalyticsPipeline,
  runAnalyticsAggregate,
} = require('../utils/iitCounsellingVisitAnalytics');

const BSON_LIMIT = 16 * 1024 * 1024;

function pipelineUsesAddToSet(node, found = []) {
  if (Array.isArray(node)) {
    node.forEach((entry) => pipelineUsesAddToSet(entry, found));
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$addToSet') found.push(node);
      pipelineUsesAddToSet(value, found);
    }
  }
  return found;
}

function normUtm(value) {
  const text = String(value ?? '').trim();
  return text || '(none)';
}

function hasUtm(doc) {
  return ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']
    .some((field) => String(doc[field] ?? '').trim().length > 0);
}

function fingerprintKey(doc) {
  return doc.visitorFingerprint == null ? null : doc.visitorFingerprint;
}

function istBucket(date, granularity) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return granularity === 'hourly' ? `${day} ${get('hour')}:00` : day;
}

function selectedDocs(docs, match) {
  return docs.filter((doc) => {
    if (doc.pageKey !== match.pageKey) return false;
    if (match.visitedAt?.$gte && doc.visitedAt < match.visitedAt.$gte) return false;
    if (match.visitedAt?.$lte && doc.visitedAt > match.visitedAt.$lte) return false;
    return true;
  });
}

function expectedVisitAnalytics(docs, match, granularity) {
  const rows = selectedDocs(docs, match);
  const totalsByFp = new Map();
  const trend = new Map();
  const referrers = new Map();
  const sources = new Map();
  const campaigns = new Map();

  for (const doc of rows) {
    const fp = fingerprintKey(doc);
    totalsByFp.set(fp, (totalsByFp.get(fp) || 0) + 1);
    const bucket = istBucket(doc.visitedAt, granularity);
    if (!trend.has(bucket)) trend.set(bucket, { totalVisits: 0, fps: new Set() });
    const trendRow = trend.get(bucket);
    trendRow.totalVisits += 1;
    trendRow.fps.add(fp);
    if (doc.referrer) referrers.set(doc.referrer, (referrers.get(doc.referrer) || 0) + 1);
    if (doc.utm_source) sources.set(doc.utm_source, (sources.get(doc.utm_source) || 0) + 1);
    if (doc.utm_campaign) campaigns.set(doc.utm_campaign, (campaigns.get(doc.utm_campaign) || 0) + 1);
  }

  const ranked = (map) => [...map.entries()]
    .map(([key, visits]) => ({ key, visits }))
    .sort((a, b) => b.visits - a.visits);

  return {
    totalVisits: rows.length,
    uniqueVisitors: totalsByFp.size,
    trend: [...trend.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([bucket, row]) => ({
        bucket,
        totalVisits: row.totalVisits,
        uniqueVisitors: row.fps.size,
      })),
    topReferrers: ranked(referrers).map((row) => ({ referrer: row.key, visits: row.visits })),
    topUtmSources: ranked(sources).map((row) => ({ source: row.key, visits: row.visits })),
    topCampaigns: ranked(campaigns).map((row) => ({ campaign: row.key, visits: row.visits })),
  };
}

function expectedUtmAnalytics(docs, match, linkedIdField) {
  const rows = selectedDocs(docs, match);
  const summaryByFp = new Map();
  const dimensions = {
    utm_source: new Map(),
    utm_medium: new Map(),
    utm_campaign: new Map(),
    utm_content: new Map(),
  };
  const combos = new Map();

  for (const doc of rows) {
    const fp = fingerprintKey(doc);
    if (!summaryByFp.has(fp)) summaryByFp.set(fp, { visits: 0, withUtm: 0, withoutUtm: 0 });
    const summary = summaryByFp.get(fp);
    summary.visits += 1;
    if (hasUtm(doc)) summary.withUtm += 1;
    else summary.withoutUtm += 1;

    for (const field of Object.keys(dimensions)) {
      const label = normUtm(doc[field]);
      if (!dimensions[field].has(label)) {
        dimensions[field].set(label, { visits: 0, fps: new Set(), linked: 0 });
      }
      const dim = dimensions[field].get(label);
      dim.visits += 1;
      dim.fps.add(fp);
      if (doc[linkedIdField] != null) dim.linked += 1;
    }

    const comboKey = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].map((field) => normUtm(doc[field])).join('|');
    if (!combos.has(comboKey)) {
      combos.set(comboKey, {
        utm_source: normUtm(doc.utm_source),
        utm_medium: normUtm(doc.utm_medium),
        utm_campaign: normUtm(doc.utm_campaign),
        utm_content: normUtm(doc.utm_content),
        visits: 0,
        fps: new Set(),
        linked: 0,
        firstVisitAt: doc.visitedAt,
        latestVisitAt: doc.visitedAt,
      });
    }
    const combo = combos.get(comboKey);
    combo.visits += 1;
    combo.fps.add(fp);
    if (doc[linkedIdField] != null) combo.linked += 1;
    if (doc.visitedAt < combo.firstVisitAt) combo.firstVisitAt = doc.visitedAt;
    if (doc.visitedAt > combo.latestVisitAt) combo.latestVisitAt = doc.visitedAt;
  }

  let visitsWithAnyUtm = 0;
  let uniqueVisitorsWithUtm = 0;
  let uniqueVisitorsWithoutUtm = 0;
  for (const row of summaryByFp.values()) {
    visitsWithAnyUtm += row.withUtm;
    if (row.withUtm > 0) uniqueVisitorsWithUtm += 1;
    if (row.withoutUtm > 0) uniqueVisitorsWithoutUtm += 1;
  }

  const top = (map, labelKey) => [...map.entries()]
    .map(([label, row]) => ({
      [labelKey]: label,
      visits: row.visits,
      uniqueVisitors: row.fps.size,
      linkedSubmissions: row.linked,
    }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 15);

  return {
    summary: {
      totalVisits: rows.length,
      visitsWithAnyUtm,
      visitsWithoutUtm: rows.length - visitsWithAnyUtm,
      uniqueVisitors: summaryByFp.size,
      uniqueVisitorsWithUtm,
      uniqueVisitorsWithoutUtm,
    },
    bySource: top(dimensions.utm_source, 'utm_source'),
    byMedium: top(dimensions.utm_medium, 'utm_medium'),
    byCampaign: top(dimensions.utm_campaign, 'utm_campaign'),
    byContent: top(dimensions.utm_content, 'utm_content'),
    byCombo: [...combos.values()]
      .sort((a, b) => b.latestVisitAt - a.latestVisitAt)
      .slice(0, 500)
      .map((row) => ({
        utm_source: row.utm_source,
        utm_medium: row.utm_medium,
        utm_campaign: row.utm_campaign,
        utm_content: row.utm_content,
        visits: row.visits,
        uniqueVisitors: row.fps.size,
        linkedSubmissions: row.linked,
        firstVisitAt: row.firstVisitAt,
        latestVisitAt: row.latestVisitAt,
      })),
  };
}

function rankedRows(rows, key) {
  return [...rows].sort((a, b) => b.visits - a.visits || String(a[key]).localeCompare(String(b[key])));
}

function comparableCombo(rows) {
  return rows
    .map((row) => ({
      ...row,
      firstVisitAt: new Date(row.firstVisitAt).toISOString(),
      latestVisitAt: new Date(row.latestVisitAt).toISOString(),
    }))
    .sort((a, b) => (
      a.utm_source.localeCompare(b.utm_source)
      || a.utm_medium.localeCompare(b.utm_medium)
      || a.utm_campaign.localeCompare(b.utm_campaign)
      || a.utm_content.localeCompare(b.utm_content)
    ));
}

describe('IIT counselling analytics BSON guard', () => {
  test('the previous fingerprint-set document exceeds 16MB and the count document does not', () => {
    const count = 100000;
    const fingerprints = Array.from({ length: count }, (_, index) => index.toString(16).padStart(64, 'a'));
    const oldSummary = {
      uniqueFingerprints: fingerprints,
      uniqueFpWithUtm: fingerprints,
      uniqueFpWithoutUtm: fingerprints.slice(0, Math.floor(count / 2)),
    };
    assert.ok(
      calculateObjectSize(oldSummary) > BSON_LIMIT,
      'expected the old $addToSet summary to exceed the BSON document limit'
    );

    const replacement = {
      totalVisits: count,
      visitsWithAnyUtm: count,
      visitsWithoutUtm: 0,
      uniqueVisitors: count,
      uniqueVisitorsWithUtm: count,
      uniqueVisitorsWithoutUtm: Math.floor(count / 2),
    };
    assert.ok(calculateObjectSize(replacement) < 500);
  });

  test('visit and UTM pipelines do not $addToSet, and the match can use the existing index', () => {
    const dateTime = {
      hasRange: true,
      visitedAt: {
        $gte: new Date('2026-10-22T00:00:00+05:30'),
        $lte: new Date('2026-10-23T23:59:59+05:30'),
      },
      granularity: 'daily',
    };
    const match = buildVisitMatch('iitCounselling', dateTime);
    const visitPipeline = buildVisitAnalyticsPipeline(match, 'daily');
    const utmPipeline = buildUtmAnalyticsPipeline(match, 'submissionId');
    assert.equal(pipelineUsesAddToSet(visitPipeline).length, 0);
    assert.equal(pipelineUsesAddToSet(utmPipeline).length, 0);
    assert.equal(visitPipeline[0].$match.pageKey, 'iitCounselling');
    assert.ok(visitPipeline[0].$match.visitedAt.$gte instanceof Date);
    assert.deepEqual(VISIT_ANALYTICS_INDEX, { pageKey: 1, visitedAt: -1 });

    const declared = IitCounsellingVisit.schema.indexes().some(([fields]) => (
      fields.pageKey === 1 && fields.visitedAt === -1
    ));
    assert.equal(declared, true);

    const controller = fs.readFileSync(path.join(__dirname, '../controllers/adminController.js'), 'utf8');
    assert.equal(controller.includes('$addToSet'), false);
    assert.ok(ANALYTICS_MAX_TIME_MS < 45000);
  });
});

describe('IIT counselling analytics results', () => {
  let memory;
  let client;
  let visits;

  before(async () => {
    memory = await MongoMemoryServer.create();
    client = new MongoClient(memory.getUri());
    await client.connect();
    visits = client.db('iit_analytics_test').collection('visits');
    const linked = new ObjectId();
    const oct23 = new Date('2026-10-23T05:00:00.000Z');
    const oct23Later = new Date('2026-10-23T09:30:00.000Z');
    const oct22 = new Date('2026-10-22T05:00:00.000Z');
    const september = new Date('2026-09-01T05:00:00.000Z');
    await visits.insertMany([
      {
        pageKey: 'iitCounselling',
        visitedAt: oct23,
        visitorFingerprint: 'fp-a',
        referrer: 'https://instagram.example/a',
        utm_source: 'instagram',
        utm_medium: 'influencer',
        utm_campaign: 'guide',
        utm_content: 'ananya',
        submissionId: linked,
      },
      {
        pageKey: 'iitCounselling',
        visitedAt: oct23Later,
        visitorFingerprint: 'fp-a',
        referrer: 'https://instagram.example/a',
        submissionId: null,
      },
      {
        pageKey: 'iitCounselling',
        visitedAt: oct22,
        visitorFingerprint: 'fp-b',
        referrer: 'https://direct.example',
        utm_source: '   ',
        submissionId: null,
      },
      {
        pageKey: 'iitCounselling',
        visitedAt: oct23,
        visitorFingerprint: 'fp-c',
        utm_source: 'youtube',
        utm_medium: 'influencer',
        utm_campaign: 'guide',
        utm_content: 'ravi',
        submissionId: null,
      },
      {
        pageKey: 'iitCounselling',
        visitedAt: september,
        visitorFingerprint: 'fp-old',
        referrer: 'https://old.example',
        utm_source: 'instagram',
        utm_campaign: 'archive',
        submissionId: null,
      },
      {
        pageKey: 'iitCounselling',
        visitedAt: oct23,
        referrer: '',
        submissionId: null,
      },
      {
        pageKey: 'mainPage',
        visitedAt: oct23,
        visitorFingerprint: 'fp-other-page',
        referrer: 'https://should-not-count.example',
        utm_source: 'instagram',
        submissionId: null,
      },
    ]);
  });

  after(async () => {
    if (client) await client.close();
    if (memory) await memory.stop();
  });

  async function aggregate(pipeline) {
    return visits.aggregate(pipeline, { allowDiskUse: true }).toArray();
  }

  test('all-time and ranged visit analytics match an independent count', async () => {
    const docs = await visits.find({}).toArray();
    for (const granularity of ['daily', 'hourly']) {
      for (const dateTime of [
        { hasRange: false, granularity },
        {
          hasRange: true,
          granularity,
          visitedAt: {
            $gte: new Date('2026-10-22T00:00:00+05:30'),
            $lte: new Date('2026-10-23T23:59:59+05:30'),
          },
        },
      ]) {
        const match = buildVisitMatch('iitCounselling', dateTime);
        const [facet] = await aggregate(buildVisitAnalyticsPipeline(match, granularity));
        const expected = expectedVisitAnalytics(docs, match, granularity);
        const totals = facet.totals[0];
        assert.equal(totals.totalVisits, expected.totalVisits);
        assert.equal(totals.uniqueVisitors, expected.uniqueVisitors);
        assert.deepEqual(
          facet.trend.map((row) => ({
            bucket: row._id,
            totalVisits: row.totalVisits,
            uniqueVisitors: row.uniqueVisitors,
          })),
          expected.trend
        );
        assert.deepEqual(rankedRows(
          facet.topReferrers.map((row) => ({ referrer: row._id, visits: row.visits })),
          'referrer'
        ), rankedRows(expected.topReferrers, 'referrer'));
        assert.deepEqual(rankedRows(
          facet.topUtmSources.map((row) => ({ source: row._id, visits: row.visits })),
          'source'
        ), rankedRows(expected.topUtmSources, 'source'));
        assert.deepEqual(rankedRows(
          facet.topCampaigns.map((row) => ({ campaign: row._id, visits: row.visits })),
          'campaign'
        ), rankedRows(expected.topCampaigns, 'campaign'));
      }
    }
  });

  test('UTM summary, dimensions, and combos keep overlapping unique visitors', async () => {
    const docs = await visits.find({}).toArray();
    const match = buildVisitMatch('iitCounselling', { hasRange: false });
    const [facet] = await aggregate(buildUtmAnalyticsPipeline(match, 'submissionId'));
    const expected = expectedUtmAnalytics(docs, match, 'submissionId');
    assert.deepEqual(facet.summary[0], expected.summary);
    assert.deepEqual(rankedRows(facet.bySource, 'utm_source'), rankedRows(expected.bySource, 'utm_source'));
    assert.deepEqual(rankedRows(facet.byMedium, 'utm_medium'), rankedRows(expected.byMedium, 'utm_medium'));
    assert.deepEqual(rankedRows(facet.byCampaign, 'utm_campaign'), rankedRows(expected.byCampaign, 'utm_campaign'));
    assert.deepEqual(rankedRows(facet.byContent, 'utm_content'), rankedRows(expected.byContent, 'utm_content'));
    assert.deepEqual(comparableCombo(facet.byCombo), comparableCombo(expected.byCombo));

    const overlap = facet.summary[0];
    assert.ok(overlap.uniqueVisitorsWithUtm + overlap.uniqueVisitorsWithoutUtm > overlap.uniqueVisitors);
  });

  test('a transient aggregate error is retried and a BSON error is not', async () => {
    let calls = 0;
    const model = {
      aggregate() {
        calls += 1;
        const query = {
          allowDiskUse() { return query; },
          option(options) {
            assert.equal(options.maxTimeMS, ANALYTICS_MAX_TIME_MS);
            if (calls === 1) {
              const error = new Error('not primary and secondaryOk=false');
              error.name = 'MongoServerError';
              error.code = 13435;
              return Promise.reject(error);
            }
            return Promise.resolve([{ totals: [{ totalVisits: 3, uniqueVisitors: 2 }] }]);
          },
        };
        return query;
      },
    };
    const rows = await runAnalyticsAggregate(model, [{ $match: { pageKey: 'iitCounselling' } }], 'test');
    assert.equal(calls, 2);
    assert.equal(rows[0].totals[0].totalVisits, 3);

    let bsonCalls = 0;
    const failing = {
      aggregate() {
        bsonCalls += 1;
        const query = {
          allowDiskUse() { return query; },
          option() {
            const error = new Error('BSON size limit hit while building Message');
            error.name = 'MongoServerError';
            error.code = 10334;
            return Promise.reject(error);
          },
        };
        return query;
      },
    };
    await assert.rejects(
      () => runAnalyticsAggregate(failing, [{ $match: { pageKey: 'iitCounselling' } }], 'test')
    );
    assert.equal(bsonCalls, 1);
  });
});
