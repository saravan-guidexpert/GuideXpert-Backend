'use strict';

const express = require('express');
const auth = require('../controllers/crmAuthController');
const { requireCrmSession } = require('../middleware/requireCrmSession');

const router = express.Router();

router.post('/login', auth.login);
router.post('/logout', auth.logout);
router.get('/me', requireCrmSession, auth.me);
router.post('/forgot-password', auth.forgotPassword);
router.post('/reset-password', auth.resetPassword);

module.exports = router;
