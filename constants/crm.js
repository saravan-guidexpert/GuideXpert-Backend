'use strict';

/**
 * Admin section keys for the internal Consultancy CRM.
 * `consultancy-crm` grants use of the module.
 * `consultancy-crm-manager` grants referral-source correction.
 * Super Admin bypasses both checks in middleware. Navigation visibility is not authorization.
 */
const CRM_SECTION = 'consultancy-crm';
const CRM_MANAGER_SECTION = 'consultancy-crm-manager';

const CRM_PERMISSION_KEYS = [CRM_SECTION, CRM_MANAGER_SECTION];

const CONSULTANCY_STATUS = ['active', 'inactive'];
const CONTACT_STATUS = ['active', 'inactive'];
const CONSULTANCY_PIPELINE = ['fresh', 'contacted', 'meeting_done', 'onboarded'];

const CRM_PAGE_MAX_LIMIT = 100;
const CRM_ANALYTICS_MAX_DAYS = 3660;
const CRM_CALENDAR_MAX_DAYS = 370;
const CRM_VOLUME_MAX_MONTHS = 120;
const CRM_REASON_MIN = 10;
const CRM_REASON_MAX = 500;

/** Current admission state. Missing or unknown stored values are displayed as Not started and are not backfilled. */
const ADMISSION_STATUSES = Object.freeze([
  'Not started',
  'Contacted',
  'Counselling',
  'Applied',
  'Admitted',
  'Enrolled',
  'Not proceeding',
]);

/**
 * Phase 2 decision, preserved and not implemented in Phase 1:
 * block a second active admission application for the same student, institution, course, and intake.
 * There is no admission-case collection in this phase.
 */
const ADMISSION_DUPLICATE_POLICY = Object.freeze({
  phase: 2,
  implemented: false,
  rule: 'block_duplicate_active_application_for_same_student_institution_course_intake',
});

module.exports = {
  CRM_SECTION,
  CRM_SECTION_KEY: CRM_SECTION,
  CRM_MANAGER_SECTION,
  CRM_MANAGER_SECTION_KEY: CRM_MANAGER_SECTION,
  CRM_PERMISSION_KEYS,
  CONSULTANCY_STATUS,
  CONTACT_STATUS,
  CONSULTANCY_PIPELINE,
  CRM_PAGE_MAX_LIMIT,
  CRM_ANALYTICS_MAX_DAYS,
  CRM_CALENDAR_MAX_DAYS,
  CRM_VOLUME_MAX_MONTHS,
  CRM_REASON_MIN,
  CRM_REASON_MAX,
  ADMISSION_STATUSES,
  ADMISSION_DUPLICATE_POLICY,
};
