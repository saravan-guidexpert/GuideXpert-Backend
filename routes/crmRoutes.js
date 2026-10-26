'use strict';

const express = require('express');
const { CRM_MANAGER_SECTION_KEY } = require('../constants/crm');
const requireAdminSection = require('../middleware/requireAdminSection');

function requireReferralSourceCorrection(req, res, next) {
  if (req.crmUser) {
    const granted = Array.isArray(req.crmUser.permissions) ? req.crmUser.permissions : [];
    if (req.crmUser.status !== 'active' || req.crmUser.deletedAt) {
      return res.status(401).json({ success: false, message: 'This account is inactive.', code: 'account_inactive' });
    }
    if (!granted.includes('crm.referrals.correct_source')) {
      return res.status(403).json({
        success: false,
        message: 'Referral source correction requires CRM manager access.',
        code: 'permission_denied',
      });
    }
    return next();
  }
  return requireAdminSection(
    CRM_MANAGER_SECTION_KEY,
    'Referral source correction requires CRM manager access or super admin.'
  )(req, res, next);
}
const consultancy = require('../controllers/crmConsultancyController');
const students = require('../controllers/crmStudentController');

const router = express.Router();

router.get('/consultancies', consultancy.listConsultancies);
router.get('/consultancies/overview', students.consultancyOverview);
router.post('/consultancies', consultancy.createConsultancy);
router.get('/consultancies/:id/remarks', consultancy.listRemarks);
router.post('/consultancies/:id/remarks', consultancy.addRemark);
router.patch('/consultancies/:id/remarks/:remarkId', consultancy.editRemark);
router.get('/consultancies/:id/follow-ups', consultancy.listFollowUps);
router.post('/consultancies/:id/follow-ups', consultancy.recordFollowUp);
router.patch('/consultancies/:id/follow-ups/:followUpId', consultancy.updateFollowUp);
router.post('/consultancies/:id/follow-ups/:followUpId/complete', consultancy.completeFollowUp);
router.post('/consultancies/:id/follow-ups/:followUpId/cancel', consultancy.cancelFollowUp);
router.post('/consultancies/:id/owner', consultancy.reassignOwner);
router.get('/consultancies/:id/contacts', consultancy.listContacts);
router.post('/consultancies/:id/contacts', consultancy.createContact);
router.patch('/consultancies/:id/contacts/:contactId', consultancy.updateContact);
router.delete('/consultancies/:id/contacts/:contactId', consultancy.deactivateContact);
router.get('/consultancies/:id', consultancy.getConsultancy);
router.patch('/consultancies/:id', consultancy.updateConsultancy);
router.delete('/consultancies/:id', consultancy.retainConsultancy);

router.get('/students', students.listStudents);
router.post('/students', students.createStudent);
router.get('/students/:id/referral', students.getStudentReferral);
router.get('/students/:id', students.getStudent);
router.patch('/students/:id', students.updateStudent);

router.get('/intelligence/follow-ups', students.followUpIntelligence);
router.get('/intelligence/day-end', students.dayEndReport);
router.get('/intelligence/workload', students.workloadIntelligence);
router.get('/history/admissions', students.admissionHistory);
router.get('/history/assignments', students.assignmentHistory);
router.get('/history/daily', students.dailyHistory);
router.get('/audits', students.listAudits);
router.get('/activity/summary', students.activitySummary);
router.get('/activity', students.listActivity);
router.get('/activity/:source/:id', students.getActivity);
router.get('/operations', students.operations);
router.get('/analytics', students.getAnalytics);
router.get('/calendar', students.getCalendar);
router.get('/referrals', students.listReferrals);
router.post('/referrals', students.createReferral);
router.post(
  '/referrals/:id/source-correction',
  requireReferralSourceCorrection,
  students.correctReferralSource
);
router.patch('/referrals/:id', students.rejectReferralMutation);

module.exports = router;
