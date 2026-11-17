'use strict';

const JeeMockTestResultActivity = require('../../models/JeeMockTestResultActivity');

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function recordJeeResultActivity({ mobile, studentName, eligibility, attemptStatus, overall, kind }) {
  const phone = String(mobile || '').trim();
  if (!/^[6-9]\d{9}$/.test(phone)) return;
  const now = new Date();
  const viewing = kind === 'view';
  const doc = await JeeMockTestResultActivity.findOneAndUpdate(
    { mobile: phone },
    {
      $setOnInsert: { mobile: phone },
      $set: {
        studentName: studentName || 'Not available',
        eligibility: eligibility || '',
        attemptStatus: attemptStatus || '',
        overallObtained: finiteOrNull(overall && overall.obtained),
        overallTotal: finiteOrNull(overall && overall.total),
      },
    },
    { upsert: true, new: true }
  );
  if (viewing) {
    doc.viewCount = (doc.viewCount || 0) + 1;
    doc.lastViewedAt = now;
    if (!doc.firstViewedAt) doc.firstViewedAt = now;
  } else {
    doc.downloadCount = (doc.downloadCount || 0) + 1;
    doc.lastDownloadedAt = now;
    if (!doc.firstDownloadedAt) doc.firstDownloadedAt = now;
  }
  await doc.save();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listJeeResultActivity({ q = '', status = '', page = 1, limit = 25 } = {}) {
  const filter = {};
  const query = String(q || '').trim();
  if (query) {
    const pattern = new RegExp(escapeRegex(query), 'i');
    filter.$or = [{ studentName: pattern }, { mobile: pattern }];
  }
  if (status === 'downloaded') filter.downloadCount = { $gt: 0 };
  if (status === 'not_downloaded') filter.downloadCount = { $not: { $gt: 0 } };

  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const [total, rows, viewed, downloaded, notDownloaded] = await Promise.all([
    JeeMockTestResultActivity.countDocuments(filter),
    JeeMockTestResultActivity.find(filter)
      .sort({ lastViewedAt: -1, lastDownloadedAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    JeeMockTestResultActivity.countDocuments({ ...filter, viewCount: { $gt: 0 } }),
    JeeMockTestResultActivity.countDocuments({ ...filter, downloadCount: { $gt: 0 } }),
    JeeMockTestResultActivity.countDocuments({
      ...filter,
      viewCount: { $gt: 0 },
      downloadCount: { $not: { $gt: 0 } },
    }),
  ]);

  return {
    summary: {
      viewed,
      downloaded,
      notDownloaded,
    },
    rows: rows.map((row) => ({
      mobile: row.mobile,
      studentName: row.studentName || 'Not available',
      eligibility: row.eligibility || '',
      attemptStatus: row.attemptStatus || '',
      overallObtained: finiteOrNull(row.overallObtained),
      overallTotal: finiteOrNull(row.overallTotal),
      viewCount: row.viewCount || 0,
      firstViewedAt: row.firstViewedAt,
      lastViewedAt: row.lastViewedAt,
      downloadCount: row.downloadCount || 0,
      firstDownloadedAt: row.firstDownloadedAt,
      lastDownloadedAt: row.lastDownloadedAt,
    })),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.max(Math.ceil(total / safeLimit), 1),
    },
  };
}

module.exports = {
  recordJeeResultActivity,
  listJeeResultActivity,
};
