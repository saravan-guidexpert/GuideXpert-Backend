const mongoose = require('mongoose');
const SalesAnalyticsSavedUtmLink = require('../models/SalesAnalyticsSavedUtmLink');
const { getMongoQuotaExceededMessage } = require('../utils/mongoErrorMessage');

const DEFAULT_BASE_URL = 'https://www.guidexpert.co.in/become-counsellor';
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

function getRegistrationBaseUrl() {
  const raw = process.env.REGISTRATION_BASE_URL;
  if (raw && typeof raw === 'string' && /^https?:\/\//i.test(raw.trim())) {
    return raw.trim().replace(/\/?$/, '');
  }
  return DEFAULT_BASE_URL;
}

function buildRegistrationUtmUrl(influencerName, platform, campaign) {
  const baseUrl = getRegistrationBaseUrl();
  const params = new URLSearchParams({
    utm_source: PLATFORM_TO_SOURCE[platform] || String(platform).toLowerCase(),
    utm_medium: 'influencer',
    utm_campaign: campaign || 'guide_xperts',
    utm_content: influencerName.trim(),
  });
  return `${baseUrl}?${params.toString()}`;
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
    cost: costNum,
    createdAt: doc.createdAt,
  };
}

exports.listSalesAnalyticsSavedUtmLinks = async (req, res) => {
  try {
    const docs = await SalesAnalyticsSavedUtmLink.find({}).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, data: docs.map(mapDoc) });
  } catch (err) {
    console.error('[listSalesAnalyticsSavedUtmLinks]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.createSalesAnalyticsSavedUtmLink = async (req, res) => {
  try {
    const { influencerName, platform, campaign, cost } = req.body || {};
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

    const utmLink = buildRegistrationUtmUrl(influencerName.trim(), platformVal, campaignVal);
    const payload = {
      influencerName: influencerName.trim(),
      platform: platformVal,
      campaign: campaignVal,
      utmLink,
    };
    if (costVal !== null) payload.cost = costVal;

    const doc = await SalesAnalyticsSavedUtmLink.create(payload);
    return res.status(201).json({ success: true, data: mapDoc(doc) });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const msg = Object.values(err.errors).map((e) => e.message).join('; ');
      return res.status(400).json({ success: false, message: msg || 'Validation failed.' });
    }
    const quotaMsg = getMongoQuotaExceededMessage(err);
    if (quotaMsg) {
      console.error('[createSalesAnalyticsSavedUtmLink] MongoDB quota exceeded');
      return res.status(503).json({ success: false, message: quotaMsg });
    }
    console.error('[createSalesAnalyticsSavedUtmLink]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

exports.deleteSalesAnalyticsSavedUtmLink = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid link ID.' });
    }
    const doc = await SalesAnalyticsSavedUtmLink.findByIdAndDelete(id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Link not found.' });
    }
    return res.status(200).json({ success: true, message: 'Link deleted.' });
  } catch (err) {
    console.error('[deleteSalesAnalyticsSavedUtmLink]', err);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
