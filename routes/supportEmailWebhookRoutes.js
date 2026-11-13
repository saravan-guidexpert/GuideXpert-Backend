'use strict';

const express = require('express');
const router = express.Router();
const { handleGraphWebhook } = require('../controllers/supportEmailWebhookController');

// Microsoft Graph subscription validation and notification webhook endpoint.
// Validation tokens may arrive via POST or GET with query parameter `validationToken`.
router.get('/', handleGraphWebhook);
router.post('/', handleGraphWebhook);

module.exports = router;

