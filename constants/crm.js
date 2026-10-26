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

/** Labels the consultancy workspace already uses. Pipeline stage is the coarser directory group. */
const CONSULTANCY_FOLLOW_UP_STATUSES = Object.freeze([
  'Fresh Lead',
  'Contacted',
  'Meeting Scheduled',
  'Meeting Completed',
  'Interested',
  'Onboarding in Progress',
  'Not Interested',
  'Follow-up Required',
  'On Hold',
  'Discontinued',
  'On - Boarded',
]);

const CALLING_STATUSES = Object.freeze([
  'Connected',
  'Not Answered',
  'Busy',
  'Switched Off',
  'Invalid Number',
  'Call Back Requested',
  'Follow-up Required',
  'Interested',
  'Not Interested',
  'Meeting Scheduled',
  'WhatsApp Message Sent',
  'WhatsApp Call Connected',
]);

const FOLLOW_UP_PIPELINE = Object.freeze({
  'Fresh Lead': 'fresh',
  Contacted: 'contacted',
  'Meeting Scheduled': 'contacted',
  'Meeting Completed': 'meeting_done',
  Interested: 'contacted',
  'Onboarding in Progress': 'onboarded',
  'Not Interested': 'contacted',
  'Follow-up Required': 'contacted',
  'On Hold': 'contacted',
  Discontinued: 'contacted',
  'On - Boarded': 'onboarded',
});

/** Used only when a caller sets the coarse pipeline stage and not a consultancy status. */
const PIPELINE_FOLLOW_UP = Object.freeze({
  fresh: 'Fresh Lead',
  contacted: 'Contacted',
  meeting_done: 'Meeting Completed',
  onboarded: 'On - Boarded',
});

const OPEN_FOLLOW_UP_STATUSES = Object.freeze(['Meeting Scheduled', 'Follow-up Required']);
const REMARK_MAX = 500;

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
  CONSULTANCY_FOLLOW_UP_STATUSES,
  CALLING_STATUSES,
  FOLLOW_UP_PIPELINE,
  PIPELINE_FOLLOW_UP,
  OPEN_FOLLOW_UP_STATUSES,
  REMARK_MAX,
  CRM_PAGE_MAX_LIMIT,
  CRM_ANALYTICS_MAX_DAYS,
  CRM_CALENDAR_MAX_DAYS,
  CRM_VOLUME_MAX_MONTHS,
  CRM_REASON_MIN,
  CRM_REASON_MAX,
  ADMISSION_STATUSES,
  ADMISSION_DUPLICATE_POLICY,
};
