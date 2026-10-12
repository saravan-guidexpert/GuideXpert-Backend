const express = require('express');
const router = express.Router();
const {
  sendOtp,
  verifyOtp,
  logPhone,
  getDemoSlots,
  submitApplication,
  saveStep1,
  saveStep2,
  saveStep3,
  checkRegistrationStatus,
  savePostRegistrationData,
  saveRankPredictorPrediction,
  saveStudentActivity,
  getAllSubmissions,
  saveIitSection1,
  saveIitSection2,
  saveIitSection3,
  trackIitCounsellingVisit,
  getIitCounsellingSlots,
  getMsg91DiagnosticsController,
  testOtpFlowController,
} = require('../controllers/formController');
const { submitTrainingForm } = require('../controllers/trainingFormController');

router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.get('/msg91-diagnostic', getMsg91DiagnosticsController);
router.post('/test-otp-flow', testOtpFlowController);
router.post('/training-form', submitTrainingForm);
router.post('/log-phone', logPhone);
router.get('/demo-slots', getDemoSlots);
router.post('/submit-application', submitApplication);
router.post('/save-step1', saveStep1);
router.post('/save-step2', saveStep2);
router.post('/save-step3', saveStep3);
router.get('/check-registration/:phone', checkRegistrationStatus);
router.post('/save-post-registration', savePostRegistrationData);
router.post('/save-rank-predictor-prediction', saveRankPredictorPrediction);
router.post('/save-student-activity', saveStudentActivity);
router.get('/submissions', getAllSubmissions); // Diagnostic endpoint
router.get('/iit-counselling/slots', getIitCounsellingSlots);
router.post('/iit-counselling/section1', saveIitSection1);
router.post('/iit-counselling/section2', saveIitSection2);
router.post('/iit-counselling/section3', saveIitSection3);
router.post('/iit-counselling/visit', trackIitCounsellingVisit);

module.exports = router;



