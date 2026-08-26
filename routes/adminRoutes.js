const express = require('express');
const router = express.Router();
const { login, loginWithPhone, getAdminLeads, getLeadById, updateLeadNotes, updateLeadSlotBooking, updateLeadSlotByPhone, getAdminStats, exportLeads, getSlotConfigs, getSlotsForDate, updateSlotConfig, getIitSlotConfigs, updateIitSlotConfig, getIitSlotOverrides, setIitSlotOverride, getIitSlotBookingCounts, getSlotBookingCounts, getSlotOverrides, setSlotOverride, getAssessmentSubmissions, getAssessment2Submissions, getAssessment3Submissions, getAssessmentSubmissionById, getAssessment2SubmissionById, getAssessment3SubmissionById, getAssessment4Submissions, getAssessment4SubmissionById, getAssessment5Submissions, getAssessment5SubmissionById, getMissingLeads, getIitCounsellingSubmissions, getIitCounsellingSubmissionById, getIitCounsellingVisitAnalytics, getIitCounsellingUtmAnalytics, getCounsellorSupportRequests } = require('../controllers/adminController');
const {
  listIitCounsellingSavedUtmLinks,
  createIitCounsellingSavedUtmLink,
  deleteIitCounsellingSavedUtmLink,
} = require('../controllers/iitCounsellingUtmSavedLinkController');
const {
  listSalesAnalyticsSavedUtmLinks,
  createSalesAnalyticsSavedUtmLink,
  deleteSalesAnalyticsSavedUtmLink,
} = require('../controllers/salesAnalyticsSavedUtmController');
const { getMeetingAttendance } = require('../controllers/meetingController');
const { getActivationCounsellorMeetAttendance } = require('../controllers/activationCounsellorMeetController');
const { getProFormSubmissions } = require('../controllers/proFormController');
const { getDemoMeetSchedule, putDemoMeetSchedule } = require('../controllers/demoMeetScheduleController');
const { getIitMeetAttendance, getIitMeetHindiAttendance } = require('../controllers/iitMeetController');
const { getIitFirstFormSubmissions } = require('../controllers/iitFirstFormController');
const { getCollegeDostFormSubmissions } = require('../controllers/collegeDostFormController');
const { getCollegeDostMeetAttendance } = require('../controllers/collegeDostMeetController');
const { getNatCampaignSubmissions } = require('../controllers/natCampaignController');
const { getIitSecondFormSubmissions } = require('../controllers/iitSecondFormController');
const { getTrainingAttendance } = require('../controllers/trainingController');
const { getTrainingFeedback, getCertifiedCounsellors2627 } = require('../controllers/feedbackController');
const {
  getCounsellorOccupations,
  getCounsellorOccupationCategories,
} = require('../controllers/counsellorOccupationsController');
const { getTrainingFormResponses } = require('../controllers/trainingFormController');
const { getProgressCheckInSubmissions } = require('../controllers/progressCheckInController');
const { getIitainSessionFeedbackSubmissions } = require('../controllers/iitainSessionFeedbackController');
const {
  listOneOnOneCounselingLeads,
  patchOneOnOneCounselingLead,
  getOneOnOneCounselingFunnelStats,
} = require('../controllers/oneOnOneCounselingController');
const {
  createCounselor,
  listCounselors,
  updateCounselor,
  patchCounselorStatus,
  deleteCounselor,
  createSlot,
  listSlots,
  updateSlot,
  toggleSlot,
  deleteSlot,
  listGuidanceBookings,
  listGuidanceNatFollowUps,
  patchGuidanceNatFollowUp,
  cancelGuidanceBooking,
  getGuidanceReminderStatus,
} = require('../controllers/oneOnOneCounselorAdminController');
const {
  adminList,
  adminCreate,
  adminGetOne,
  adminUpdate,
  adminDelete,
  adminPublish,
  adminUnpublish,
  adminAnalytics,
} = require('../controllers/announcementController');
const {
  adminList: studentUpdatesAdminList,
  adminCreate: studentUpdatesAdminCreate,
  adminGetOne: studentUpdatesAdminGetOne,
  adminUpdate: studentUpdatesAdminUpdate,
  adminDelete: studentUpdatesAdminDelete,
  adminPublish: studentUpdatesAdminPublish,
  adminUnpublish: studentUpdatesAdminUnpublish,
} = require('../controllers/studentWorkspaceUpdateController');
const {
  adminList: studentTestimonialsAdminList,
  adminCreate: studentTestimonialsAdminCreate,
  adminGetOne: studentTestimonialsAdminGetOne,
  adminUpdate: studentTestimonialsAdminUpdate,
  adminDelete: studentTestimonialsAdminDelete,
  adminPublish: studentTestimonialsAdminPublish,
  adminUnpublish: studentTestimonialsAdminUnpublish,
} = require('../controllers/studentTestimonialController');
const {
  adminList: resourcesAdminList,
  adminUploadInit,
  adminUploadChunk,
  adminUploadComplete,
  adminUploadDirect,
  adminUpdate: resourcesAdminUpdate,
  adminPublish: resourcesAdminPublish,
  adminUnpublish: resourcesAdminUnpublish,
  adminDelete: resourcesAdminDelete,
  adminDownloadLogs,
} = require('../controllers/studentResourceController');
const { uploadMiddleware } = require('./resourceRoutes');
const requireAdmin = require('../middleware/requireAdmin');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');
const requireOsviAdminToken = require('../middleware/requireOsviAdminToken');
const { listAdmins, createAdmin, updateAdmin, deleteAdmin, resetAdminPassword, changeMyPassword } = require('../controllers/adminUserController');
const {
  bindWebinarProgressCohort,
  adminListProgress,
  adminProgressStats,
  adminProgressDetail,
  adminAssessmentDetail,
  adminUpdateProgress,
  adminBulkProgress,
  adminProgressExport,
} = require('../controllers/webinarProgressController');
const WebinarProgress = require('../models/WebinarProgress');
const WebinarProgress2627 = require('../models/WebinarProgress2627');
const {
  listPosters,
  getPoster,
  createPoster,
  updatePoster,
  deletePoster,
  publishPoster,
  unpublishPoster,
  setPosterMarketingFeatured,
} = require('../controllers/posterTemplateController');
const {
  getOsviEnabled,
  setOsviEnabled,
  getOsviAbandonedDelayMs,
  setOsviAbandonedDelayMs,
  getAdminSidebarConfig,
  setAdminSidebarConfig,
} = require('../utils/appSettings');
const {
  resolveSystemPromptForAdmin,
  setSystemPromptSetting,
  listSystemPromptHistory,
  getSystemPromptHistoryById,
} = require('../utils/systemPromptSettings');
const {
  resolveWebChatPromptForAdmin,
  setWebChatPromptSetting,
} = require('../utils/webChatPromptSettings');
const {
  getCertifiedCounsellors,
  getCertifiedCounsellorDetail,
} = require('../controllers/certifiedCounsellorsController');
const {
  listBdas,
  createBda,
  updateBda,
  deleteBda,
  patchBdaStatus,
  resetBdaPassword,
  getBdaStats,
  getBdaStatsById,
  getBdaLeaderboard,
  getBdaAssignedLeads,
  getBdaCallingData,
  getTeamDashboard,
  transferBdaLeads,
} = require('../controllers/bdaController');
const {
  listIitCounsellingLeads,
  getIitCounsellingLeadById,
  patchIitCounsellingLeadCrm,
  assignBda,
  reassignBda,
  bulkAssignBda,
  bulkReassignBda,
  bulkMapFilteredRespectiveBda,
  getAssignmentHistory,
  getAutoAssignPreview,
  autoAssignLeadsByLanguage,
} = require('../controllers/iitCounsellingLeadsController');
const {
  getBdaLeadTypes,
  listAssignableLeads,
  assignBdaLead,
  reassignBdaLead,
  bulkAssignBdaLeads,
  bulkReassignBdaLeads,
} = require('../controllers/bdaAssignableLeadsController');
router.post('/login', login);
router.post('/login-with-phone', loginWithPhone);
router.get('/admins', requireAdmin, requireSuperAdmin, listAdmins);
router.post('/admins', requireAdmin, requireSuperAdmin, createAdmin);
router.delete('/admins/:id', requireAdmin, requireSuperAdmin, deleteAdmin);
router.patch('/admins/:id/password', requireAdmin, requireSuperAdmin, resetAdminPassword);
router.patch('/admins/:id', requireAdmin, requireSuperAdmin, updateAdmin);
router.patch('/me/password', requireAdmin, changeMyPassword);
router.get('/leads', requireAdmin, getAdminLeads);
router.get('/leads/:id', requireAdmin, getLeadById);
router.patch('/leads/:id', requireAdmin, updateLeadNotes);
router.patch('/leads/:id/slot', requireAdmin, updateLeadSlotBooking);
router.patch('/leads/slot-by-phone', requireOsviAdminToken, updateLeadSlotByPhone);
router.get('/stats', requireAdmin, getAdminStats);
router.get('/leads/export', requireAdmin, exportLeads);
router.get('/slots', requireAdmin, getSlotConfigs);
router.get('/slots/for-date', requireAdmin, getSlotsForDate);
router.get('/slots/booking-counts', requireAdmin, getSlotBookingCounts);
router.get('/slots/overrides', requireAdmin, getSlotOverrides);
router.put('/slots/overrides', requireAdmin, setSlotOverride);
router.put('/slots/:slotId', requireAdmin, updateSlotConfig);
router.get('/iit-slots', requireAdmin, getIitSlotConfigs);
router.put('/iit-slots/:slotId', requireAdmin, updateIitSlotConfig);
router.get('/iit-slots/booking-counts', requireAdmin, getIitSlotBookingCounts);
router.get('/iit-slots/overrides', requireAdmin, getIitSlotOverrides);
router.put('/iit-slots/overrides', requireAdmin, setIitSlotOverride);
router.get('/demo-meet-schedule', requireAdmin, getDemoMeetSchedule);
router.put('/demo-meet-schedule', requireAdmin, putDemoMeetSchedule);
router.get('/meeting-attendance', requireAdmin, getMeetingAttendance);
router.get('/activation-counsellor-meet-attendance', requireAdmin, getActivationCounsellorMeetAttendance);
router.get('/pro-form-submissions', requireAdmin, getProFormSubmissions);
router.get('/iit-meet-attendance', requireAdmin, getIitMeetAttendance);
router.get('/iit-meet-hindi-attendance', requireAdmin, getIitMeetHindiAttendance);
router.get('/iit-first-form-submissions', requireAdmin, getIitFirstFormSubmissions);
router.get('/college-dost-form-submissions', requireAdmin, getCollegeDostFormSubmissions);
router.get('/college-dost-meet-attendance', requireAdmin, getCollegeDostMeetAttendance);
router.get('/nat-campaign-submissions', requireAdmin, getNatCampaignSubmissions);
router.get('/iit-second-form-submissions', requireAdmin, getIitSecondFormSubmissions);
router.get('/training-attendance', requireAdmin, getTrainingAttendance);
router.get('/training-feedback', requireAdmin, getTrainingFeedback);
router.get('/certified-counsellors-26-27', requireAdmin, getCertifiedCounsellors2627);
router.get('/counsellor-occupations/categories', requireAdmin, getCounsellorOccupationCategories);
router.get('/counsellor-occupations', requireAdmin, getCounsellorOccupations);
router.get('/training-form-responses', requireAdmin, getTrainingFormResponses);
router.get('/nurturing', requireAdmin, getProgressCheckInSubmissions);
router.get('/iitain-session-feedback', requireAdmin, getIitainSessionFeedbackSubmissions);
router.get('/one-on-one-counseling-leads/funnel-stats', requireAdmin, getOneOnOneCounselingFunnelStats);
router.get('/one-on-one-counseling-leads', requireAdmin, listOneOnOneCounselingLeads);
router.patch('/one-on-one-counseling-leads/:id', requireAdmin, patchOneOnOneCounselingLead);
router.post('/one-on-one-counselors', requireAdmin, requireSuperAdmin, createCounselor);
router.get('/one-on-one-counselors', requireAdmin, listCounselors);
router.put('/one-on-one-counselors/:id', requireAdmin, requireSuperAdmin, updateCounselor);
router.patch('/one-on-one-counselors/:id/status', requireAdmin, requireSuperAdmin, patchCounselorStatus);
router.delete('/one-on-one-counselors/:id', requireAdmin, requireSuperAdmin, deleteCounselor);
router.post('/guidance-slots', requireAdmin, createSlot);
router.get('/guidance-slots', requireAdmin, listSlots);
router.put('/guidance-slots/:id', requireAdmin, updateSlot);
router.patch('/guidance-slots/:id/toggle', requireAdmin, toggleSlot);
router.delete('/guidance-slots/:id', requireAdmin, deleteSlot);
router.get('/guidance-bookings', requireAdmin, listGuidanceBookings);
router.get('/guidance-nat-follow-ups', requireAdmin, listGuidanceNatFollowUps);
router.patch('/guidance-nat-follow-ups/:id', requireAdmin, patchGuidanceNatFollowUp);
router.post('/guidance-bookings/:id/cancel', requireAdmin, cancelGuidanceBooking);
router.get('/guidance-reminder-status', requireAdmin, getGuidanceReminderStatus);
router.get('/counsellor-support-requests', requireAdmin, getCounsellorSupportRequests);
router.get('/assessment-submissions', requireAdmin, getAssessmentSubmissions);
router.get('/assessment-submissions/:id', requireAdmin, getAssessmentSubmissionById);
router.get('/assessment-2-submissions', requireAdmin, getAssessment2Submissions);
router.get('/assessment-2-submissions/:id', requireAdmin, getAssessment2SubmissionById);
router.get('/assessment-3-submissions', requireAdmin, getAssessment3Submissions);
router.get('/assessment-3-submissions/:id', requireAdmin, getAssessment3SubmissionById);
router.get('/assessment-4-submissions', requireAdmin, getAssessment4Submissions);
router.get('/assessment-4-submissions/:id', requireAdmin, getAssessment4SubmissionById);
router.get('/assessment-5-submissions', requireAdmin, getAssessment5Submissions);
router.get('/assessment-5-submissions/:id', requireAdmin, getAssessment5SubmissionById);
router.get('/missing-leads', requireAdmin, getMissingLeads);
router.get('/iit-counselling', requireAdmin, getIitCounsellingSubmissions);
router.get('/iit-counselling/visits', requireAdmin, getIitCounsellingVisitAnalytics);
router.get('/iit-counselling/utm-analytics', requireAdmin, getIitCounsellingUtmAnalytics);
// Must be registered before GET /iit-counselling/:id so "saved-utm-links" is never parsed as an ObjectId.
router.get('/iit-counselling/saved-utm-links', requireAdmin, listIitCounsellingSavedUtmLinks);
router.post('/iit-counselling/saved-utm-links', requireAdmin, createIitCounsellingSavedUtmLink);
router.delete('/iit-counselling/saved-utm-links/:id', requireAdmin, deleteIitCounsellingSavedUtmLink);
// Flat aliases (older clients); keep after the /iit-counselling/* literals above.
router.get('/iit-utm-saved-links', requireAdmin, listIitCounsellingSavedUtmLinks);
router.post('/iit-utm-saved-links', requireAdmin, createIitCounsellingSavedUtmLink);
router.delete('/iit-utm-saved-links/:id', requireAdmin, deleteIitCounsellingSavedUtmLink);
// Admin → Analytics page only (not InfluencerLink / influencer tracking).
router.get('/sales-analytics-saved-utm-links', requireAdmin, listSalesAnalyticsSavedUtmLinks);
router.post('/sales-analytics-saved-utm-links', requireAdmin, createSalesAnalyticsSavedUtmLink);
router.delete('/sales-analytics-saved-utm-links/:id', requireAdmin, deleteSalesAnalyticsSavedUtmLink);
router.get('/iit-counselling/:id', requireAdmin, getIitCounsellingSubmissionById);
router.get('/certified-counsellors', requireAdmin, getCertifiedCounsellors);
router.get('/certified-counsellors/:id', requireAdmin, getCertifiedCounsellorDetail);
// Calling Team — BDA & IIT counselling leads CRM (register literals before :id)
router.get('/bdas/stats', requireAdmin, getBdaStats);
router.get('/bdas/leaderboard', requireAdmin, getBdaLeaderboard);
router.get('/bdas/team-dashboard', requireAdmin, getTeamDashboard);
router.get('/bdas/calling-data', requireAdmin, getBdaCallingData);
router.get('/bdas', requireAdmin, listBdas);
router.post('/bdas', requireAdmin, createBda);
router.get('/bdas/:id/stats', requireAdmin, getBdaStatsById);
router.get('/bdas/:id/assigned-leads', requireAdmin, getBdaAssignedLeads);
router.patch('/bdas/:id', requireAdmin, updateBda);
router.delete('/bdas/:id', requireAdmin, deleteBda);
router.patch('/bdas/:id/status', requireAdmin, patchBdaStatus);
router.patch('/bdas/:id/reset-password', requireAdmin, resetBdaPassword);
router.patch('/bdas/:id/transfer-leads', requireAdmin, transferBdaLeads);
router.get('/bda-lead-types', requireAdmin, getBdaLeadTypes);
router.get('/bda-assignable-leads', requireAdmin, listAssignableLeads);
router.patch('/bda-assignable-leads/bulk-assign', requireAdmin, bulkAssignBdaLeads);
router.patch('/bda-assignable-leads/bulk-reassign', requireAdmin, bulkReassignBdaLeads);
router.patch('/bda-assignable-leads/:leadType/:id/assign-bda', requireAdmin, assignBdaLead);
router.patch('/bda-assignable-leads/:leadType/:id/reassign-bda', requireAdmin, reassignBdaLead);
router.get('/iit-counselling-leads', requireAdmin, listIitCounsellingLeads);
router.get('/iit-counselling-leads/auto-assign-preview', requireAdmin, getAutoAssignPreview);
router.post('/iit-counselling-leads/auto-assign-by-language', requireAdmin, autoAssignLeadsByLanguage);
router.patch('/iit-counselling-leads/bulk-assign', requireAdmin, bulkAssignBda);
router.patch('/iit-counselling-leads/bulk-reassign', requireAdmin, bulkReassignBda);
router.patch(
  '/iit-counselling-leads/bulk-map-filtered-respective',
  requireAdmin,
  bulkMapFilteredRespectiveBda
);
router.get('/iit-counselling-leads/:id/assignment-history', requireAdmin, getAssignmentHistory);
router.patch('/iit-counselling-leads/:id/crm', requireAdmin, patchIitCounsellingLeadCrm);
router.patch('/iit-counselling-leads/:id/assign-bda', requireAdmin, assignBda);
router.patch('/iit-counselling-leads/:id/reassign-bda', requireAdmin, reassignBda);
router.get('/iit-counselling-leads/:id', requireAdmin, getIitCounsellingLeadById);
router.get('/announcements', requireAdmin, adminList);
router.post('/announcements', requireAdmin, adminCreate);
router.get('/announcements/:id/analytics', requireAdmin, adminAnalytics);
router.get('/announcements/:id', requireAdmin, adminGetOne);
router.patch('/announcements/:id', requireAdmin, adminUpdate);
router.delete('/announcements/:id', requireAdmin, adminDelete);
router.post('/announcements/:id/publish', requireAdmin, adminPublish);
router.post('/announcements/:id/unpublish', requireAdmin, adminUnpublish);

router.get('/student-workspace-updates', requireAdmin, studentUpdatesAdminList);
router.post('/student-workspace-updates', requireAdmin, studentUpdatesAdminCreate);
router.get('/student-workspace-updates/:id', requireAdmin, studentUpdatesAdminGetOne);
router.patch('/student-workspace-updates/:id', requireAdmin, studentUpdatesAdminUpdate);
router.delete('/student-workspace-updates/:id', requireAdmin, studentUpdatesAdminDelete);
router.post('/student-workspace-updates/:id/publish', requireAdmin, studentUpdatesAdminPublish);
router.post('/student-workspace-updates/:id/unpublish', requireAdmin, studentUpdatesAdminUnpublish);

router.get('/student-testimonials', requireAdmin, studentTestimonialsAdminList);
router.post('/student-testimonials', requireAdmin, studentTestimonialsAdminCreate);
router.get('/student-testimonials/:id', requireAdmin, studentTestimonialsAdminGetOne);
router.patch('/student-testimonials/:id', requireAdmin, studentTestimonialsAdminUpdate);
router.delete('/student-testimonials/:id', requireAdmin, studentTestimonialsAdminDelete);
router.post('/student-testimonials/:id/publish', requireAdmin, studentTestimonialsAdminPublish);
router.post('/student-testimonials/:id/unpublish', requireAdmin, studentTestimonialsAdminUnpublish);

router.get('/resources/downloads', requireAdmin, adminDownloadLogs);
router.get('/resources', requireAdmin, resourcesAdminList);
router.post('/resources/upload/init', requireAdmin, adminUploadInit);
router.post('/resources/upload/direct', requireAdmin, adminUploadDirect);
router.post('/resources/upload/chunk', requireAdmin, uploadMiddleware.single('chunk'), adminUploadChunk);
router.post('/resources/upload/complete', requireAdmin, adminUploadComplete);
router.patch('/resources/:id', requireAdmin, resourcesAdminUpdate);
router.post('/resources/:id/publish', requireAdmin, resourcesAdminPublish);
router.post('/resources/:id/unpublish', requireAdmin, resourcesAdminUnpublish);
router.delete('/resources/:id', requireAdmin, resourcesAdminDelete);

router.get('/posters', requireAdmin, listPosters);
router.post('/posters', requireAdmin, createPoster);
router.get('/posters/:id', requireAdmin, getPoster);
router.put('/posters/:id', requireAdmin, updatePoster);
router.delete('/posters/:id', requireAdmin, deletePoster);
router.post('/posters/:id/publish', requireAdmin, publishPoster);
router.post('/posters/:id/unpublish', requireAdmin, unpublishPoster);
router.post('/posters/:id/marketing-featured', requireAdmin, setPosterMarketingFeatured);

// OSVI outbound call history
router.get('/osvi-calls', requireAdmin, async (req, res) => {
  try {
    const FormSubmission = require('../models/FormSubmission');
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    const statusFilter = req.query.status;

    const query = { osviOutboundCallStatus: { $exists: true } };
    if (statusFilter && ['pending', 'processing', 'completed', 'failed', 'cancelled'].includes(statusFilter)) {
      query.osviOutboundCallStatus = statusFilter;
    }

    const [docs, total] = await Promise.all([
      FormSubmission.find(query)
        .sort({ osviOutboundScheduledAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('phone fullName step1Data osviOutboundCallStatus osviOutboundScheduledAt osviOutboundCompletedAt osviOutboundLastError selectedSlot registeredAt')
        .lean(),
      FormSubmission.countDocuments(query),
    ]);

    const rows = docs.map((d) => ({
      id: d._id,
      phone: d.phone ? `***${String(d.phone).slice(-4)}` : '—',
      name: d.step1Data?.fullName || d.fullName || '—',
      slot: d.selectedSlot || '—',
      status: d.osviOutboundCallStatus,
      scheduledAt: d.osviOutboundScheduledAt,
      completedAt: d.osviOutboundCompletedAt,
      lastError: d.osviOutboundLastError || null,
      registeredAt: d.registeredAt,
    }));

    return res.json({ success: true, rows, total, page, limit });
  } catch (err) {
    console.error('[Admin] osvi-calls error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// App-wide feature toggles
router.get('/app-settings/osvi', requireAdmin, async (req, res) => {
  try {
    const [osviEnabled, osviAbandonedDelayMs] = await Promise.all([
      getOsviEnabled(),
      getOsviAbandonedDelayMs(),
    ]);
    return res.json({ success: true, osviEnabled, osviAbandonedDelayMs });
  } catch (err) {
    console.error('[AppSettings] GET osvi error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.patch('/app-settings/osvi', requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { enabled, osviAbandonedDelayMs } = req.body || {};
    const hasEnabled = typeof enabled === 'boolean';
    const hasDelay = osviAbandonedDelayMs != null;

    if (!hasEnabled && !hasDelay) {
      return res.status(400).json({
        success: false,
        message: 'Provide `enabled` (boolean) and/or `osviAbandonedDelayMs` (non-negative number)',
      });
    }
    if (hasDelay) {
      const delay = Number(osviAbandonedDelayMs);
      if (!Number.isFinite(delay) || delay < 0) {
        return res.status(400).json({
          success: false,
          message: '`osviAbandonedDelayMs` must be a non-negative number',
        });
      }
    }
    let nextEnabled;
    let nextDelayMs;

    if (hasEnabled) {
      nextEnabled = await setOsviEnabled(enabled);
      console.log(`[AppSettings] OSVI outbound calls set to: ${nextEnabled} by admin`);
    } else {
      nextEnabled = await getOsviEnabled();
    }

    if (hasDelay) {
      nextDelayMs = await setOsviAbandonedDelayMs(osviAbandonedDelayMs);
      console.log(`[AppSettings] OSVI abandoned delay set to ${nextDelayMs}ms by admin`);
    } else {
      nextDelayMs = await getOsviAbandonedDelayMs();
    }

    return res.json({
      success: true,
      osviEnabled: nextEnabled,
      osviAbandonedDelayMs: nextDelayMs,
    });
  } catch (err) {
    console.error('[AppSettings] PATCH osvi error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.get('/app-settings/sidebar', requireAdmin, async (req, res) => {
  try {
    const sidebarConfig = await getAdminSidebarConfig();
    return res.json({ success: true, sidebarConfig });
  } catch (err) {
    console.error('[AppSettings] GET sidebar error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.patch('/app-settings/sidebar', requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { sectionsEnabled, overrides } = req.body || {};
    const hasSections =
      sectionsEnabled &&
      (typeof sectionsEnabled.counsellors === 'boolean' || typeof sectionsEnabled.students === 'boolean');
    const hasOverrides = overrides && typeof overrides === 'object';

    if (!hasSections && !hasOverrides) {
      return res.status(400).json({
        success: false,
        message: 'Provide `sectionsEnabled` and/or `overrides`',
      });
    }

    const partial = {};
    if (hasSections) partial.sectionsEnabled = sectionsEnabled;
    if (hasOverrides) partial.overrides = overrides;

    const sidebarConfig = await setAdminSidebarConfig(partial);
    console.log('[AppSettings] Admin sidebar config updated by super admin');
    return res.json({ success: true, sidebarConfig });
  } catch (err) {
    console.error('[AppSettings] PATCH sidebar error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Flow V3 chatbot system prompt (Mongo source of truth; .md mirrored when writable)
router.get('/system-prompt', requireAdmin, async (req, res) => {
  try {
    const prompt = await resolveSystemPromptForAdmin();
    return res.json({
      success: true,
      text: prompt.text,
      hash: prompt.hash,
      bytes: prompt.bytes,
      updatedAt: prompt.updatedAt,
      updatedByEmail: prompt.updatedByEmail,
      source: prompt.source,
    });
  } catch (err) {
    console.error('[SystemPrompt] GET error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.put('/system-prompt', requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Provide non-empty `text` (string)',
      });
    }

    const saved = await setSystemPromptSetting(text, req.admin || null);
    // The LLM-only chatbot reads the prompt from Mongo on every message,
    // so the save is live immediately — no cache to clear.

    console.log('[SystemPrompt] Updated by admin', {
      hash: saved.hash,
      bytes: saved.bytes,
      mirroredToFile: saved.mirroredToFile,
      by: saved.updatedByEmail,
    });

    return res.json({
      success: true,
      text: saved.text,
      hash: saved.hash,
      bytes: saved.bytes,
      updatedAt: saved.updatedAt,
      updatedByEmail: saved.updatedByEmail,
      source: saved.source,
      mirroredToFile: saved.mirroredToFile,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : 'Internal server error';
    const status = /must be|exceeds|non-empty/i.test(msg) ? 400 : 500;
    console.error('[SystemPrompt] PUT error:', err);
    return res.status(status).json({ success: false, message: msg });
  }
});

router.get('/system-prompt/history', requireAdmin, async (req, res) => {
  try {
    const items = await listSystemPromptHistory({
      limit: req.query?.limit != null ? Number(req.query.limit) : undefined,
    });
    return res.json({ success: true, items });
  } catch (err) {
    console.error('[SystemPrompt] GET history error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.get('/system-prompt/history/:id', requireAdmin, async (req, res) => {
  try {
    const item = await getSystemPromptHistoryById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'History item not found' });
    }
    return res.json({ success: true, ...item });
  } catch (err) {
    console.error('[SystemPrompt] GET history item error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * Reset WhatsApp chatbot lead for one phone — profile, chats, handoffs, scoring.
 * Next inbound message is treated as a brand-new lead.
 */
router.post('/chatbot/clear-profile', requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { normalizePhone10 } = require('../utils/chatbotPhone');
    const { clearWhatsAppChatbotLead } = require('../services/chatbot/clearChatbotLeadService');
    const phone10 = normalizePhone10(req.body?.phone);
    if (!phone10 || phone10.length !== 10) {
      return res.status(400).json({
        success: false,
        message: 'Provide a valid 10-digit Indian mobile number in `phone`.',
      });
    }

    const result = await clearWhatsAppChatbotLead(phone10);
    const { deleted, totalRemoved } = result;

    console.log('[ClearChatbotProfile] full lead reset by admin', {
      phoneSuffix: phone10.slice(-4),
      ...deleted,
      by: req.admin?.email || req.admin?.username || null,
    });

    return res.json({
      success: true,
      phone: phone10,
      deleted,
      message:
        totalRemoved > 0
          ? `Reset lead ${phone10}: removed ${deleted.inboundMessages} inbound and ${deleted.outboundMessages} outbound messages, profile, and bot state.`
          : `No chatbot data found for ${phone10}.`,
    });
  } catch (err) {
    console.error('[ClearChatbotProfile] error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Website chatbot (student panel web chat) system prompt (Mongo source of truth; default fallback)
router.get('/web-chat-system-prompt', requireAdmin, async (req, res) => {
  try {
    const prompt = await resolveWebChatPromptForAdmin();
    return res.json({
      success: true,
      text: prompt.text,
      hash: prompt.hash,
      bytes: prompt.bytes,
      updatedAt: prompt.updatedAt,
      updatedByEmail: prompt.updatedByEmail,
      source: prompt.source,
    });
  } catch (err) {
    console.error('[WebChatPrompt] GET error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.put('/web-chat-system-prompt', requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Provide non-empty `text` (string)',
      });
    }

    const saved = await setWebChatPromptSetting(text, req.admin || null);

    console.log('[WebChatPrompt] Updated by admin', {
      hash: saved.hash,
      bytes: saved.bytes,
      by: saved.updatedByEmail,
    });

    return res.json({
      success: true,
      text: saved.text,
      hash: saved.hash,
      bytes: saved.bytes,
      updatedAt: saved.updatedAt,
      updatedByEmail: saved.updatedByEmail,
      source: saved.source,
    });
  } catch (err) {
    const msg = err && err.message ? err.message : 'Internal server error';
    const status = /must be|exceeds|non-empty/i.test(msg) ? 400 : 500;
    console.error('[WebChatPrompt] PUT error:', err);
    return res.status(status).json({ success: false, message: msg });
  }
});

// Certificates (bulk download) — lazy-load controller so native canvas deps do not crash serverless cold start
router.post('/certificates/bulk-download', requireAdmin, (req, res, next) => {
  const { bulkDownloadCertificates } = require('../controllers/certificateBulkController');
  return bulkDownloadCertificates(req, res, next);
});

// Training progress 25-26 (frozen) and 26-27 (live)
function mountWebinarProgressAdmin(prefix, ...middleware) {
  router.get(`${prefix}/stats`, requireAdmin, ...middleware, adminProgressStats);
  router.get(`${prefix}/export`, requireAdmin, ...middleware, adminProgressExport);
  router.post(`${prefix}/bulk`, requireAdmin, ...middleware, adminBulkProgress);
  router.patch(`${prefix}/:phone`, requireAdmin, ...middleware, adminUpdateProgress);
  router.get(`${prefix}/:phone/assessments`, requireAdmin, ...middleware, adminAssessmentDetail);
  router.get(`${prefix}/:phone`, requireAdmin, ...middleware, adminProgressDetail);
  router.get(prefix, requireAdmin, ...middleware, adminListProgress);
}

mountWebinarProgressAdmin('/webinar-progress', bindWebinarProgressCohort(WebinarProgress, '25-26'));
mountWebinarProgressAdmin('/webinar-progress-26-27', bindWebinarProgressCohort(WebinarProgress2627, '26-27'));

module.exports = router;
