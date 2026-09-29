const PosterTemplate = require('../models/PosterTemplate');
const TrainingFeedback = require('../models/TrainingFeedback');
const ProFormSubmission = require('../models/ProFormSubmission');
const { isPrivilegedPhone } = require('../utils/privilegedAccess');
const {
  MAX_POSTER_SVG_CHARS,
  formatPosterSvgLimitLabel,
} = require('../utils/posterSvgLimits');

/** Public poster URLs must live under /p/... (React Router + SPA). */
function isPosterPublicPath(routeNorm) {
  return typeof routeNorm === 'string' && routeNorm.startsWith('/p/') && routeNorm.length > 3;
}

function normalizeMobile10(raw) {
  if (raw == null) return '';
  const d = String(raw).replace(/\D/g, '').slice(-10);
  return d.length === 10 ? d : '';
}

const POSTER_AUDIENCES = ['counsellor', 'pro'];

function firstScalar(value) {
  if (Array.isArray(value)) return firstScalar(value[0]);
  if (value == null) return '';
  return String(value);
}

function normalizeAudience(raw) {
  const s = firstScalar(raw).trim().toLowerCase();
  return POSTER_AUDIENCES.includes(s) ? s : 'counsellor';
}

function requestedAudience(req) {
  return normalizeAudience(
    req.query?.audience || req.headers['x-poster-audience'] || req.body?.audience
  );
}

/** Mongo filter for an audience; counsellor also matches legacy docs that predate the field. */
function audienceFilter(audience) {
  return audience === 'pro' ? { audience: 'pro' } : { audience: { $ne: 'pro' } };
}

function posterMatchesAudience(doc, audience) {
  return normalizeAudience(doc?.audience) === audience;
}

/** Trim, strip query/hash, ensure leading slash, lowercase for stable matching. */
function normalizeRoute(route) {
  if (route == null) return '';
  let s = String(route).trim();
  if (!s) return '';
  s = s.split('?')[0].split('#')[0];
  if (!s.startsWith('/')) s = `/${s}`;
  return s.toLowerCase();
}

function isLikelySvg(s) {
  if (typeof s !== 'string' || !s.length) return false;
  return /<svg[\s>/]/i.test(s.trim());
}

/** Strip BOM and outer whitespace; keeps markup valid for length / SVG checks. */
function normalizeIncomingSvgTemplate(raw) {
  if (raw == null) return '';
  let s = String(raw);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.trim();
}

/**
 * @param {object} raw
 * @param {{ allowXEnd?: boolean }} [opts] - When false (mobile), xEnd is never stored.
 */
function sanitizeOverlayField(raw, opts = {}) {
  const { allowXEnd = false } = opts;
  const xCandidate = raw?.anchorX ?? raw?.x;
  const x = Number(xCandidate);
  const y = Number(raw?.y);
  const textValue = raw?.textValue != null ? String(raw.textValue).slice(0, 500) : '';
  const base = {
    x: Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : 12,
    anchorX: Number.isFinite(x) ? Math.min(100, Math.max(0, x)) : 12,
    anchorType: ['start', 'end', 'center'].includes(raw?.anchorType) ? raw.anchorType : 'start',
    y: Number.isFinite(y) ? Math.min(100, Math.max(0, y)) : 12,
    textValue,
    fontSize: Number.isFinite(Number(raw?.fontSize)) ? Math.min(400, Math.max(4, Number(raw.fontSize))) : 20,
    color: raw?.color != null ? String(raw.color).slice(0, 32) : '#111827',
    fontWeight: raw?.fontWeight != null ? String(raw.fontWeight).slice(0, 32) : '600',
    textAlign: ['left', 'center', 'right', 'justify'].includes(raw?.textAlign) ? raw.textAlign : 'left',
  };
  if (!allowXEnd) return base;
  const xe = Number(raw?.xEnd);
  if (!Number.isFinite(xe)) return base;
  const xEnd = Math.min(100, Math.max(0, xe));
  if (xEnd <= base.x) return base;
  return { ...base, xEnd };
}

/** Plain object with only schema keys — avoids stray client fields on create/update. */
function toPlainOverlayField(raw, allowXEnd) {
  const s = sanitizeOverlayField(raw, { allowXEnd });
  const out = {
    x: s.x,
    anchorX: s.anchorX,
    anchorType: s.anchorType,
    y: s.y,
    textValue: s.textValue,
    fontSize: s.fontSize,
    color: s.color,
    fontWeight: s.fontWeight,
    textAlign: s.textAlign,
  };
  if (allowXEnd && typeof s.xEnd === 'number' && Number.isFinite(s.xEnd)) {
    out.xEnd = s.xEnd;
  }
  return out;
}

function defaultNameField() {
  return sanitizeOverlayField(
    { x: 12, anchorType: 'start', y: 12, textValue: 'Sample name', fontSize: 22, fontWeight: '600' },
    { allowXEnd: true }
  );
}

function defaultMobileField() {
  return sanitizeOverlayField(
    { x: 12, anchorType: 'start', y: 24, textValue: '98765 43210', fontSize: 18, fontWeight: '500' },
    { allowXEnd: false }
  );
}

function withRoleTextDefault(field, role) {
  const fallback = role === 'name' ? defaultNameField().textValue : defaultMobileField().textValue;
  if (field?.textValue != null && String(field.textValue).trim() !== '') return field;
  return { ...field, textValue: fallback };
}

/** Map old `elements[]` documents to nameField / mobileField */
function migrateLegacyElements(elements) {
  if (!Array.isArray(elements) || elements.length === 0) {
    return { nameField: defaultNameField(), mobileField: defaultMobileField() };
  }
  const byId = (id) => elements.find((e) => e && String(e.id) === id);
  const nameSrc = byId('name') || elements[0];
  const mobileSrc =
    byId('mobile') || byId('phone') || (elements.length > 1 ? elements[1] : null);
  return {
    nameField: withRoleTextDefault(
      sanitizeOverlayField(nameSrc || defaultNameField(), { allowXEnd: true }),
      'name'
    ),
    mobileField: withRoleTextDefault(
      sanitizeOverlayField(mobileSrc || defaultMobileField(), { allowXEnd: false }),
      'mobile'
    ),
  };
}

function resolveFieldsFromDoc(o) {
  const hasNew =
    o.nameField &&
    o.mobileField &&
    typeof o.nameField === 'object' &&
    typeof o.mobileField === 'object';
  if (hasNew) {
    return {
      nameField: withRoleTextDefault(sanitizeOverlayField(o.nameField, { allowXEnd: true }), 'name'),
      mobileField: withRoleTextDefault(sanitizeOverlayField(o.mobileField, { allowXEnd: false }), 'mobile'),
    };
  }
  if (Array.isArray(o.elements) && o.elements.length > 0) {
    return migrateLegacyElements(o.elements);
  }
  return { nameField: defaultNameField(), mobileField: defaultMobileField() };
}

function toDto(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  const { nameField, mobileField } = resolveFieldsFromDoc(o);
  return {
    id: String(o._id),
    name: o.name,
    description: o.description != null ? String(o.description) : '',
    route: o.route,
    audience: normalizeAudience(o.audience),
    svgTemplate: o.svgTemplate,
    nameField,
    mobileField,
    published: !!o.published,
    publishedAt: o.publishedAt || null,
    marketingFeatured: !!o.marketingFeatured,
    marketingFeaturedAt: o.marketingFeaturedAt || null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/** Public API: poster config without leaking admin-only fields (same fields; published always true when returned). */
function toPublicDto(doc) {
  const base = toDto(doc);
  if (!base) return null;
  delete base.published;
  delete base.publishedAt;
  return base;
}

function toMarketingPosterDto(doc) {
  const base = toDto(doc);
  if (!base) return null;
  return {
    id: base.id,
    name: base.name,
    description: base.description,
    route: base.route,
    svgTemplate: base.svgTemplate,
    nameField: base.nameField,
    mobileField: base.mobileField,
    publishedAt: base.publishedAt || null,
    marketingFeatured: !!base.marketingFeatured,
    marketingFeaturedAt: base.marketingFeaturedAt || null,
    createdAt: base.createdAt || null,
    updatedAt: base.updatedAt || null,
  };
}

exports.normalizeRoute = normalizeRoute;

exports.listPosters = async (req, res) => {
  try {
    const audience = requestedAudience(req);
    const rows = await PosterTemplate.find(audienceFilter(audience)).sort({ updatedAt: -1 }).lean();
    return res.json({ success: true, posters: rows.map((r) => toDto(r)) });
  } catch (err) {
    console.error('[listPosters]', err);
    return res.status(500).json({ success: false, message: 'Failed to list posters.' });
  }
};

exports.getPoster = async (req, res) => {
  try {
    const doc = await PosterTemplate.findById(req.params.id).lean();
    if (!doc || !posterMatchesAudience(doc, requestedAudience(req))) {
      return res.status(404).json({ success: false, message: 'Poster not found.' });
    }
    return res.json({ success: true, poster: toDto(doc) });
  } catch (err) {
    console.error('[getPoster]', err);
    return res.status(500).json({ success: false, message: 'Failed to load poster.' });
  }
};

exports.createPoster = async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const name = body.name != null ? String(body.name).trim() : '';
    const description = body.description != null ? String(body.description).trim().slice(0, 500) : '';
    const svgRaw = body.svgTemplate ?? body.svg_template;
    const hasSvgKey =
      Object.prototype.hasOwnProperty.call(body, 'svgTemplate') ||
      Object.prototype.hasOwnProperty.call(body, 'svg_template');
    const svgTemplate = normalizeIncomingSvgTemplate(svgRaw);
    const routeNorm = normalizeRoute(body.route);

    const bad = (code, message, extra = {}) => {
      console.warn('[createPoster] 400', code, {
        nameLen: name.length,
        descriptionLen: description.length,
        route: routeNorm || '(empty)',
        svgLen: svgTemplate.length,
        bodyKeys: Object.keys(body),
        ...extra,
      });
      return res.status(400).json({ success: false, message, code, ...extra });
    };

    if (!name || name.length > 200) {
      return bad('POSTER_NAME', 'name is required (max 200 chars).');
    }
    if (!routeNorm) {
      return bad('POSTER_ROUTE', 'route is required.');
    }
    if (!isPosterPublicPath(routeNorm)) {
      return bad(
        'POSTER_ROUTE_PUBLIC',
        'route must start with /p/ (e.g. /p/my-campaign) so the public app can serve this poster.'
      );
    }
    if (!svgTemplate.length) {
      return bad(
        'POSTER_SVG_EMPTY',
        !hasSvgKey
          ? 'svgTemplate is missing from the JSON body. Use Content-Type: application/json and include svgTemplate with the full <svg>… markup (field name must be svgTemplate).'
          : 'svgTemplate was present but empty after trim. Re-upload the .svg file or paste the markup again.',
        { hasSvgKey, bodyKeys: Object.keys(body) }
      );
    }
    if (svgTemplate.length > MAX_POSTER_SVG_CHARS) {
      return bad(
        'POSTER_SVG_TOO_LARGE',
        `svgTemplate exceeds ${formatPosterSvgLimitLabel()} (this file is ${(svgTemplate.length / (1024 * 1024)).toFixed(1)} MB). Simplify the SVG or reduce embedded images.`
      );
    }
    if (!isLikelySvg(svgTemplate)) {
      return bad(
        'POSTER_SVG_MARKUP',
        'svgTemplate must look like SVG markup (expect a root <svg> element).'
      );
    }

    const nameField = toPlainOverlayField(body.nameField ?? defaultNameField(), true);
    const mobileField = toPlainOverlayField(body.mobileField ?? defaultMobileField(), false);

    const exists = await PosterTemplate.findOne({ route: routeNorm }).lean();
    if (exists) {
      return res.status(409).json({ success: false, message: 'A poster for this route already exists.' });
    }

    const doc = await PosterTemplate.create({
      name,
      description,
      route: routeNorm,
      audience: normalizeAudience(body.audience),
      svgTemplate,
      nameField,
      mobileField,
      published: false,
      publishedAt: null,
    });
    return res.status(201).json({ success: true, poster: toDto(doc) });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: 'A poster for this route already exists.' });
    }
    if (err.name === 'ValidationError') {
      const first =
        err.errors && typeof err.errors === 'object'
          ? Object.values(err.errors).map((e) => e?.message).filter(Boolean)[0]
          : null;
      console.error('[createPoster] ValidationError', err.message, err.errors);
      return res.status(400).json({
        success: false,
        code: 'POSTER_VALIDATION',
        message: first || err.message || 'Invalid poster data.',
      });
    }
    console.error('[createPoster]', err);
    const dev = process.env.NODE_ENV !== 'production';
    return res.status(500).json({
      success: false,
      message: dev ? err.message || 'Failed to create poster.' : 'Failed to create poster.',
    });
  }
};

exports.updatePoster = async (req, res) => {
  try {
    const doc = await PosterTemplate.findById(req.params.id);
    if (!doc || !posterMatchesAudience(doc, requestedAudience(req))) {
      return res.status(404).json({ success: false, message: 'Poster not found.' });
    }

    const body = req.body || {};
    if (body.name != null) {
      const name = String(body.name).trim();
      if (!name || name.length > 200) {
        return res.status(400).json({ success: false, message: 'Invalid name.' });
      }
      doc.name = name;
    }
    if (body.route != null) {
      const routeNorm = normalizeRoute(body.route);
      if (!routeNorm) {
        return res.status(400).json({ success: false, message: 'Invalid route.' });
      }
      if (!isPosterPublicPath(routeNorm)) {
        return res.status(400).json({
          success: false,
          message: 'route must start with /p/ (e.g. /p/my-campaign).',
        });
      }
      if (routeNorm !== doc.route) {
        const clash = await PosterTemplate.findOne({ route: routeNorm, _id: { $ne: doc._id } }).lean();
        if (clash) {
          return res.status(409).json({ success: false, message: 'A poster for this route already exists.' });
        }
        doc.route = routeNorm;
      }
    }
    if (body.description != null) {
      doc.description = String(body.description).trim().slice(0, 500);
    }
    if (body.svgTemplate != null || body.svg_template != null) {
      const svgTemplate = normalizeIncomingSvgTemplate(body.svgTemplate ?? body.svg_template);
      if (!svgTemplate.length) {
        return res.status(400).json({ success: false, message: 'Invalid svgTemplate (empty).', code: 'POSTER_SVG_EMPTY' });
      }
      if (svgTemplate.length > MAX_POSTER_SVG_CHARS) {
        return res.status(400).json({
          success: false,
          message: `svgTemplate exceeds ${formatPosterSvgLimitLabel()}.`,
          code: 'POSTER_SVG_TOO_LARGE',
        });
      }
      if (!isLikelySvg(svgTemplate)) {
        return res.status(400).json({
          success: false,
          message: 'svgTemplate must look like SVG markup.',
          code: 'POSTER_SVG_MARKUP',
        });
      }
      doc.svgTemplate = svgTemplate;
    }
    if (body.nameField != null) {
      doc.nameField = toPlainOverlayField(body.nameField, true);
    }
    if (body.mobileField != null) {
      doc.mobileField = toPlainOverlayField(body.mobileField, false);
    }
    doc.markModified('nameField');
    doc.markModified('mobileField');

    await doc.save();
    return res.json({ success: true, poster: toDto(doc) });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: 'A poster for this route already exists.' });
    }
    console.error('[updatePoster]', err);
    return res.status(500).json({ success: false, message: 'Failed to update poster.' });
  }
};

exports.deletePoster = async (req, res) => {
  try {
    const doc = await PosterTemplate.findById(req.params.id).lean();
    if (!doc || !posterMatchesAudience(doc, requestedAudience(req))) {
      return res.status(404).json({ success: false, message: 'Poster not found.' });
    }
    const result = await PosterTemplate.deleteOne({ _id: doc._id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Poster not found.' });
    }
    return res.json({ success: true, message: 'Deleted.' });
  } catch (err) {
    console.error('[deletePoster]', err);
    return res.status(500).json({ success: false, message: 'Failed to delete poster.' });
  }
};

exports.getPosterByRoute = async (req, res) => {
  try {
    const routeNorm = normalizeRoute(req.query.route);
    if (!routeNorm) {
      return res.status(400).json({ success: false, message: 'Missing or invalid route query parameter.' });
    }
    const doc = await PosterTemplate.findOne({ route: routeNorm, published: true }).lean();
    if (!doc) {
      return res.status(404).json({ success: false, message: 'No published poster for this route.' });
    }
    return res.json({ success: true, poster: toPublicDto(doc) });
  } catch (err) {
    console.error('[getPosterByRoute]', err);
    return res.status(500).json({ success: false, message: 'Failed to load poster.' });
  }
};

exports.publishPoster = async (req, res) => {
  try {
    const doc = await PosterTemplate.findById(req.params.id);
    if (!doc || !posterMatchesAudience(doc, requestedAudience(req))) {
      return res.status(404).json({ success: false, message: 'Poster not found.' });
    }
    const routeNorm = normalizeRoute(doc.route);
    if (!isPosterPublicPath(routeNorm)) {
      return res.status(400).json({
        success: false,
        message: 'Save a route starting with /p/ before publishing.',
      });
    }
    if (!doc.svgTemplate || !isLikelySvg(String(doc.svgTemplate))) {
      return res.status(400).json({ success: false, message: 'Upload a valid SVG before publishing.' });
    }
    doc.published = true;
    doc.publishedAt = new Date();
    await doc.save();
    return res.json({ success: true, poster: toDto(doc) });
  } catch (err) {
    console.error('[publishPoster]', err);
    return res.status(500).json({ success: false, message: 'Failed to publish poster.' });
  }
};

exports.unpublishPoster = async (req, res) => {
  try {
    const doc = await PosterTemplate.findById(req.params.id);
    if (!doc || !posterMatchesAudience(doc, requestedAudience(req))) {
      return res.status(404).json({ success: false, message: 'Poster not found.' });
    }
    doc.published = false;
    doc.publishedAt = null;
    doc.marketingFeatured = false;
    doc.marketingFeaturedAt = null;
    await doc.save();
    return res.json({ success: true, poster: toDto(doc) });
  } catch (err) {
    console.error('[unpublishPoster]', err);
    return res.status(500).json({ success: false, message: 'Failed to unpublish poster.' });
  }
};

/**
 * POST /api/posters/verify-activation — public; mobile must match TrainingFeedback for this published route.
 */
/**
 * POST /api/admin/posters/:id/marketing-featured — body: { featured: boolean }
 */
exports.setPosterMarketingFeatured = async (req, res) => {
  try {
    const raw = req.body?.featured;
    const featured = raw === true || raw === 'true';
    const doc = await PosterTemplate.findById(req.params.id);
    if (!doc || !posterMatchesAudience(doc, requestedAudience(req))) {
      return res.status(404).json({ success: false, message: 'Poster not found.' });
    }
    if (featured) {
      if (!doc.published) {
        return res.status(400).json({
          success: false,
          message: 'Only published posters can be featured in counsellor Marketing.',
        });
      }
      doc.marketingFeatured = true;
      doc.marketingFeaturedAt = new Date();
      await doc.save();
    } else {
      doc.marketingFeatured = false;
      doc.marketingFeaturedAt = null;
      await doc.save();
    }
    return res.json({ success: true, poster: toDto(doc) });
  } catch (err) {
    console.error('[setPosterMarketingFeatured]', err);
    return res.status(500).json({ success: false, message: 'Failed to update marketing feature.' });
  }
};

/**
 * GET /api/posters/marketing — public; no auth. Lists all published automated posters for Marketing.
 */
exports.getMarketingPosters = async (req, res) => {
  try {
    const audience = requestedAudience(req);
    const docs = await PosterTemplate.find({ published: true, ...audienceFilter(audience) })
      .sort({ marketingFeaturedAt: -1, publishedAt: -1, updatedAt: -1 })
      .lean();
    const posters = docs.map((doc) => toMarketingPosterDto(doc)).filter(Boolean);
    return res.json({ success: true, posters });
  } catch (err) {
    console.error('[getMarketingPosters]', err);
    return res.status(500).json({ success: false, message: 'Failed to load marketing posters.' });
  }
};

/**
 * GET /api/posters/marketing-featured — public; no auth.
 */
exports.getMarketingFeaturedPoster = async (req, res) => {
  try {
    const audience = requestedAudience(req);
    const docs = await PosterTemplate.find({ published: true, ...audienceFilter(audience) })
      .sort({ marketingFeaturedAt: -1, publishedAt: -1, updatedAt: -1 })
      .lean();
    const posters = docs.map((doc) => toMarketingPosterDto(doc)).filter(Boolean);
    const doc = await PosterTemplate.findOne({
      published: true,
      marketingFeatured: true,
      ...audienceFilter(audience),
    })
      .select('name route marketingFeaturedAt')
      .lean();
    if (!doc) {
      return res.json({ success: true, poster: null, posters });
    }
    return res.json({
      success: true,
      posters,
      poster: {
        name: doc.name,
        route: doc.route,
        marketingFeaturedAt: doc.marketingFeaturedAt || null,
      },
    });
  } catch (err) {
    console.error('[getMarketingFeaturedPoster]', err);
    return res.status(500).json({ success: false, message: 'Failed to load featured poster.' });
  }
};

exports.verifyPosterActivation = async (req, res) => {
  try {
    const routeNorm = normalizeRoute(req.body?.route ?? req.query?.route);
    const mobile = normalizeMobile10(req.body?.mobile ?? req.body?.phone ?? req.body?.mobileNumber);
    if (!routeNorm) {
      return res.status(400).json({ success: false, message: 'route is required.' });
    }
    if (!mobile) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit mobile number is required.' });
    }
    const poster = await PosterTemplate.findOne({ route: routeNorm, published: true }).lean();
    if (!poster) {
      return res.status(404).json({ success: false, message: 'No published poster for this page.' });
    }
    if (isPrivilegedPhone(mobile)) {
      return res.json({
        success: true,
        name: 'Privileged QA',
        mobile,
      });
    }
    if (normalizeAudience(poster.audience) === 'pro') {
      const pro = await ProFormSubmission.findOne({
        $or: [{ contactNumber: mobile }, { alternateNumber: mobile }],
      })
        .lean()
        .select('name contactNumber');
      if (!pro) {
        return res.status(200).json({
          success: false,
          code: 'NOT_FOUND',
          message: 'This number is not registered in PRO data.',
        });
      }
      return res.json({
        success: true,
        name: pro.name || '',
        mobile: pro.contactNumber || mobile,
      });
    }
    const fb = await TrainingFeedback.findOne({ mobileNumber: mobile }).lean().select('name mobileNumber');
    if (!fb) {
      return res.status(200).json({
        success: false,
        code: 'NOT_FOUND',
        message: 'No activation record found for this number.',
      });
    }
    return res.json({
      success: true,
      name: fb.name || '',
      mobile: fb.mobileNumber || mobile,
    });
  } catch (err) {
    console.error('[verifyPosterActivation]', err);
    return res.status(500).json({ success: false, message: 'Verification failed.' });
  }
};
