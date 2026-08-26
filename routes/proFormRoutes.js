const express = require('express');
const router = express.Router();
const { attachRouteIndex } = require('../utils/routeIndex');
const { proFormHealth, submitProForm } = require('../controllers/proFormController');

attachRouteIndex(router, {
  name: 'pro-form',
  routes: [
    { method: 'GET', path: '/health' },
    { method: 'POST', path: '/' },
    { method: 'POST', path: '/submit' },
  ],
});
router.get('/health', proFormHealth);
router.post('/', submitProForm);
router.post('/submit', submitProForm);

module.exports = router;
