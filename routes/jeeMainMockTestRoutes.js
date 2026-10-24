const express = require('express');
const router = express.Router();
const { attachRouteIndex } = require('../utils/routeIndex');
const {
  saveJeeMainMockTestSection1,
  saveJeeMainMockTestSection2,
} = require('../controllers/jeeMainMockTestController');

attachRouteIndex(router, {
  name: 'jee-main-mock-test',
  routes: [
    { method: 'POST', path: '/section1' },
    { method: 'POST', path: '/section2' },
  ],
});

router.post('/section1', saveJeeMainMockTestSection1);
router.post('/section2', saveJeeMainMockTestSection2);

module.exports = router;
