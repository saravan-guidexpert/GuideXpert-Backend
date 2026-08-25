const express = require('express');
const router = express.Router();
const { attachRouteIndex } = require('../utils/routeIndex');
const {
  activationCounsellorMeetHealth,
  activationCounsellorMeetEligibility,
  registerForActivationCounsellorMeet,
} = require('../controllers/activationCounsellorMeetController');

attachRouteIndex(router, {
  name: 'activation-counsellor-meet',
  routes: [
    { method: 'GET', path: '/health' },
    { method: 'POST', path: '/eligibility' },
    { method: 'POST', path: '/register' },
  ],
});
router.get('/health', activationCounsellorMeetHealth);
router.post('/eligibility', activationCounsellorMeetEligibility);
router.post('/register', registerForActivationCounsellorMeet);

module.exports = router;
