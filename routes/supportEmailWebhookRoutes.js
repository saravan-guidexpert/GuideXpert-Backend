'use strict';

const express = require('express');
const router = express.Router();
const { handleGraphWebhook } = require('../controllers/supportEmailWebhookController');

// Microsoft Graph subscription validation and notification webhook endpoints.
// Validation tokens may arrive via POST or GET with query parameter `validationToken`.
// Supports both primary notification URL and dedicated lifecycle notification URL.
router.get('/', handleGraphWebhook);
router.post('/', handleGraphWebhook);
router.get('/lifecycle', handleGraphWebhook);
router.post('/lifecycle', handleGraphWebhook);

module.exports = router;

