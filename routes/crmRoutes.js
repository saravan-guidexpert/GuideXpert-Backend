'use strict';

const express = require('express');
const { CRM_MANAGER_SECTION_KEY } = require('../constants/crm');
const requireAdminSection = require('../middleware/requireAdminSection');
const consultancy = require('../controllers/crmConsultancyController');
const students = require('../controllers/crmStudentController');

const router = express.Router();

router.get('/consultancies', consultancy.listConsultancies);
router.post('/consultancies', consultancy.createConsultancy);
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

router.get('/analytics', students.getAnalytics);
router.get('/calendar', students.getCalendar);
router.get('/referrals', students.listReferrals);
router.post('/referrals', students.createReferral);
router.post(
  '/referrals/:id/source-correction',
  requireAdminSection(
    CRM_MANAGER_SECTION_KEY,
    'Referral source correction requires CRM manager access or super admin.'
  ),
  students.correctReferralSource
);
router.patch('/referrals/:id', students.rejectReferralMutation);

module.exports = router;
