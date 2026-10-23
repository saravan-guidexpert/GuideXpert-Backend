const mongoose = require('mongoose');
const IitCounsellingUtmSavedLink = require('../models/IitCounsellingUtmSavedLink');
const { getMongoQuotaExceededMessage } = require('../utils/mongoErrorMessage');

const DEFAULT_IIT_PAGE = 'https://guidexpert.co.in/iit-counselling';
const DEFAULT_ONE_ON_ONE_SESSION_PAGE_URL = 'https://www.guidexpert.co.in/one-on-one-session';
const DEFAULT_GUIDANCE_BOOKING_CONFIRMATION_PAGE_URL =
  'https://www.guidexpert.co.in/guidance-booking-confirmation';
const DEFAULT_MAIN_PAGE_URL = 'https://guidexpert.co.in';
const PLATFORM_TO_SOURCE = {
  Instagram: 'instagram',
  YouTube: 'youtube',
  Twitter: 'twitter',
  X: 'x',
  WhatsApp: 'whatsapp',
  Telegram: 'telegram',
  Facebook: 'facebook',
  LinkedIn: 'linkedin',
};

function normalizeBaseUrl(raw, fallback) {
  const base = (raw && typeof raw === 'string' && raw.trim()) ? raw.trim() : fallback;
  return base.replace(/\/?$/, '');
}

function getIitCounsellingBaseUrl() {
  return normalizeBaseUrl(process.env.IIT_COUNSELLING_PAGE_URL, DEFAULT_IIT_PAGE);
}

function getOneOnOneSessionBaseUrl() {
  return normalizeBaseUrl(process.env.ONE_ON_ONE_SESSION_PAGE_URL, DEFAULT_ONE_ON_ONE_SESSION_PAGE_URL);
}

function getGuidanceBookingConfirmationBaseUrl() {
  return normalizeBaseUrl(
    process.env.GUIDANCE_BOOKING_CONFIRMATION_PAGE_URL,
    DEFAULT_GUIDANCE_BOOKING_CONFIRMATION_PAGE_URL,
  );
}

function buildUtmUrlOnBase(baseUrl, influencerName, platform, campaign) {
  const params = new URLSearchParams({
    utm_source: PLATFORM_TO_SOURCE[platform] || String(platform).toLowerCase(),
    utm_medium: 'influencer',
    utm_campaign: campaign || 'guide_xperts',
    utm_content: influencerName.trim(),
  });
  return `${baseUrl}?${params.toString()}`;
}

function buildIitCounsellingUtmUrl(influencerName, platform, campaign) {
  return buildUtmUrlOnBase(getIitCounsellingBaseUrl(), influencerName, platform, campaign);
}

function buildOneOnOneSessionUtmUrl(influencerName, platform, campaign) {
  return buildUtmUrlOnBase(getOneOnOneSessionBaseUrl(), influencerName, platform, campaign);
}

function buildGuidanceBookingConfirmationUtmUrl(influencerName, platform, campaign) {
  return buildUtmUrlOnBase(
    getGuidanceBookingConfirmationBaseUrl(),
    influencerName,
    platform,
    campaign,
  );
}

function getMainPageBaseUrl() {
  return normalizeBaseUrl(process.env.MAIN_PAGE_URL, DEFAULT_MAIN_PAGE_URL);
}

function buildMainPageUtmUrl(influencerName, platform, campaign) {
  return buildUtmUrlOnBase(getMainPageBaseUrl(), influencerName, platform, campaign);
}

function normalizeLinkTarget(value) {
  if (value == null || value === '') return 'iitCounselling';
  const s = String(value).trim().toLowerCase().replace(/-/g, '_');
  if (s === 'oneononesession' || s === 'one_on_one_session') return 'oneOnOneSession';
  if (s === 'guidancebookingconfirmation' || s === 'guidance_booking_confirmation') {
    return 'guidanceBookingConfirmation';
  }
  if (
    s === 'mainpage' || s === 'main_page' || s === 'home'
    || s === 'jeemocktest' || s === 'jee_mock_test'
  ) return 'mainPage';
  return 'iitCounselling';
}

function resolveDocLinkTarget(doc) {
  if (doc.linkTarget === 'mainPage') return 'mainPage';
  if (doc.linkTarget === 'guidanceBookingConfirmation') return 'guidanceBookingConfirmation';
  if (doc.linkTarget === 'oneOnOneSession') return 'oneOnOneSession';
  const url = doc.utmLink || '';
  if (/^https?:\/\/[^/]+\/?(?:\?|#|$)/i.test(url)) return 'mainPage';
  if (/^https?:\/\/[^/]+\/guidance-booking-confirmation(\/|\?|#|$)/i.test(url)) {
    return 'guidanceBookingConfirmation';
  }
  if (/^https?:\/\/[^/]+\/one-on-one-session(\/|\?|#|$)/i.test(url)) return 'oneOnOneSession';
  return 'iitCounselling';
}

function parseCost(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return undefined;
  return n;
}

function mapDoc(doc) {
  const costNum = doc.cost != null && typeof doc.cost === 'number' ? doc.cost : null;
  return {
    id: doc._id,
    influencerName: doc.influencerName,
    platform: doc.platform,
    campaign: doc.campaign,
    utmLink: doc.utmLink,
    linkTarget: resolveDocLinkTarget(doc),
    cost: costNum,
    createdAt: doc.createdAt,
  };
}

function buildListFilter(linkTargetParam) {
  if (linkTargetParam === 'mainPage') {
    return {
      $or: [
        { linkTarget: 'mainPage' },
        { utmLink: { $regex: /^https?:\/\/[^/]+\/?(?:\?|#|$)/i } },
      ],
    };
  }
  if (linkTargetParam === 'guidanceBookingConfirmation') {
    return {
      $or: [
        { linkTarget: 'guidanceBookingConfirmation' },
        { utmLink: { $regex: /^https?:\/\/[^/]+\/guidance-booking-confirmation(\/|\?|#|$)/i } },
      ],
    };
  }
  if (linkTargetParam === 'oneOnOneSession') {
    return {
      $or: [
        { linkTarget: 'oneOnOneSession' },
        { utmLink: { $regex: /^https?:\/\/[^/]+\/one-on-one-session(\/|\?|#|$)/i } },
      ],
    };
  }
  return {
    $or: [
      { linkTarget: { $exists: false } },
      { linkTarget: null },
      { linkTarget: 'iitCounselling' },
    ],
  };
}

/**
 * GET /api/admin/iit-counselling/saved-utm-links
 * Query: linkTarget=iitCounselling|oneOnOneSession|guidanceBookingConfirmation (optional, default iitCounselling)
 */
exports.listIitCounsellingSavedUtmLinks = async (req, res) => {
  try {
    const filterParam = normalizeLinkTarget(req.query?.linkTarget);
    const mongoFilter = buildListFilter(filterParam);
    const docs = await IitCounsellingUtmSavedLink.find(mongoFilter).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, data: docs.map(mapDoc) });
  } catch (err) {
    console.error('[listIitCounsellingSavedUtmLinks]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * POST /api/admin/iit-counselling/saved-utm-links
 * Body: { influencerName, platform, campaign?, cost?, linkTarget?: 'iitCounselling' | 'oneOnOneSession' | 'guidanceBookingConfirmation' }
 */
exports.createIitCounsellingSavedUtmLink = async (req, res) => {
  try {
    const { influencerName, platform, campaign, cost } = req.body || {};
    const linkTarget = normalizeLinkTarget(req.body?.linkTarget);
    if (!influencerName || typeof influencerName !== 'string' || !influencerName.trim()) {
      return res.status(400).json({ success: false, message: 'Influencer name is required.' });
    }
    const platformVal = platform || 'Instagram';
    const allowed = ['Instagram', 'YouTube', 'Twitter', 'X', 'WhatsApp', 'Telegram', 'Facebook', 'LinkedIn'];
    if (!allowed.includes(platformVal)) {
      return res.status(400).json({ success: false, message: 'Invalid platform.' });
    }
    const campaignVal = (campaign && typeof campaign === 'string' && campaign.trim()) ? campaign.trim() : 'guide_xperts';
    const costVal = parseCost(cost);
    if (costVal === undefined) {
      return res.status(400).json({ success: false, message: 'Cost must be a non-negative number.' });
    }

    const utmLink = linkTarget === 'oneOnOneSession'
      ? buildOneOnOneSessionUtmUrl(influencerName.trim(), platformVal, campaignVal)
      : linkTarget === 'guidanceBookingConfirmation'
        ? buildGuidanceBookingConfirmationUtmUrl(influencerName.trim(), platformVal, campaignVal)
        : linkTarget === 'mainPage'
          ? buildMainPageUtmUrl(influencerName.trim(), platformVal, campaignVal)
          : buildIitCounsellingUtmUrl(influencerName.trim(), platformVal, campaignVal);
    const payload = {
      influencerName: influencerName.trim(),
      platform: platformVal,
      campaign: campaignVal,
      utmLink,
      linkTarget,
    };
    if (costVal !== null) payload.cost = costVal;

    const doc = await IitCounsellingUtmSavedLink.create(payload);
    return res.status(201).json({ success: true, data: mapDoc(doc) });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors).map((e) => e.message).join('; ');
      return res.status(400).json({ success: false, message: msg || 'Validation failed.' });
    }
    const quotaMsg = getMongoQuotaExceededMessage(err);
    if (quotaMsg) {
      console.error('[createIitCounsellingSavedUtmLink] MongoDB quota exceeded');
      return res.status(503).json({ success: false, message: quotaMsg });
    }
    console.error('[createIitCounsellingSavedUtmLink]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * DELETE /api/admin/iit-counselling/saved-utm-links/:id
 */
exports.deleteIitCounsellingSavedUtmLink = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid link ID.' });
    }
    const doc = await IitCounsellingUtmSavedLink.findByIdAndDelete(id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Link not found.' });
    }
    return res.status(200).json({ success: true, message: 'Link deleted.' });
  } catch (err) {
    console.error('[deleteIitCounsellingSavedUtmLink]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
