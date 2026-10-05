const express = require('express');
const router = express.Router();
const { attachRouteIndex } = require('../utils/routeIndex');
const { saveJeeSessionSection1, saveJeeSessionSection2 } = require('../controllers/jeeSessionController');

attachRouteIndex(router, {
  name: 'jee-sessions',
  routes: [
    { method: 'POST', path: '/section1' },
    { method: 'POST', path: '/section2' },
  ],
});

router.post('/section1', saveJeeSessionSection1);
router.post('/section2', saveJeeSessionSection2);

module.exports = router;
