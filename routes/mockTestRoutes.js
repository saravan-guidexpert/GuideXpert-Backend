const express = require('express');
const router = express.Router();
const { attachRouteIndex } = require('../utils/routeIndex');
const { saveMockTestSection1, saveMockTestSection2 } = require('../controllers/mockTestController');

attachRouteIndex(router, {
  name: 'mock-test',
  routes: [
    { method: 'POST', path: '/section1' },
    { method: 'POST', path: '/section2' },
  ],
});

router.post('/section1', saveMockTestSection1);
router.post('/section2', saveMockTestSection2);

module.exports = router;
