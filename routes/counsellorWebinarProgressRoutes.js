const express = require('express');
const requireCounsellor = require('../middleware/requireCounsellor');
const WebinarProgress2627 = require('../models/WebinarProgress2627');

const router = express.Router();

/**
 * GET /api/counsellor/webinar-progress
 * Same document shape as GET /api/admin/webinar-progress-26-27/:phone, but only for the
 * logged-in counsellor's phone (from Counsellor document). Reads the current 26-27 cohort.
 */
router.get('/webinar-progress', requireCounsellor, async (req, res) => {
  try {
    const raw = req.counsellor?.phone;
    const phone = raw != null ? String(raw).replace(/\D/g, '').slice(-10) : '';
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Add a valid 10-digit phone to your counsellor profile to load webinar training progress.',
      });
    }

    const doc = await WebinarProgress2627.findOne({ phone }).lean();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    if (!doc) {
      return res.status(200).json({ success: true, data: null });
    }
    return res.status(200).json({ success: true, data: doc });
  } catch (err) {
    console.error('[counsellorWebinarProgress]', err);
    return res.status(500).json({ success: false, message: 'Failed to load webinar progress.' });
  }
});

module.exports = router;
