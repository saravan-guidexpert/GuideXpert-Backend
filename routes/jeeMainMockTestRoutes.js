const express = require('express');
const router = express.Router();
const { attachRouteIndex } = require('../utils/routeIndex');
const {
  saveJeeMainMockTestSection1,
  saveJeeMainMockTestSection2,
} = require('../controllers/jeeMainMockTestController');
const {
  requestOtp,
  pending,
  resendOtp,
  cancel,
  verifyOtp,
  me,
  pdf,
  logout,
} = require('../controllers/jeeMockTestResultController');

attachRouteIndex(router, {
  name: 'jee-main-mock-test',
  routes: [
    { method: 'POST', path: '/section1' },
    { method: 'POST', path: '/section2' },
    { method: 'POST', path: '/results/request-otp' },
    { method: 'GET', path: '/results/pending' },
    { method: 'POST', path: '/results/resend-otp' },
    { method: 'POST', path: '/results/cancel' },
    { method: 'POST', path: '/results/verify-otp' },
    { method: 'GET', path: '/results/me' },
    { method: 'GET', path: '/results/pdf' },
    { method: 'POST', path: '/results/logout' },
  ],
});

router.post('/section1', saveJeeMainMockTestSection1);
router.post('/section2', saveJeeMainMockTestSection2);
router.post('/results/request-otp', requestOtp);
router.get('/results/pending', pending);
router.post('/results/resend-otp', resendOtp);
router.post('/results/cancel', cancel);
router.post('/results/verify-otp', verifyOtp);
router.get('/results/me', me);
router.get('/results/pdf', pdf);
router.post('/results/logout', logout);

module.exports = router;
