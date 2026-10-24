const WhatsAppRetryGroup = require('../models/WhatsAppRetryGroup');
const { isGupshupConfigured, sendJeeMockTestSubmitWhatsApp, isIntegrationStub } = require('./gupshupService');
const { safeSendWhatsApp } = require('../utils/safeSendWhatsApp');
const {
  resolveJeeMockTestTemplate,
  buildJeeMockTestSubmitVars,
  resolveJeeMockTestHeaderImageUrl,
  ensureJeeMockTestTemplateEnv,
  asJeeMockTestWhatsAppLead,
  JEE_MOCK_TEST_OPS_PRODUCT,
} = require('../utils/jeeMockTestWhatsApp');

/**
 * Send the influencer JEE mock-test template after a completed registration.
 * Registration still succeeds when WhatsApp is skipped or the provider rejects it.
 * @param {object} doc MockTestLead or JeeMainMockTestLead
 */
async function dispatchJeeMockTestWhatsApp(doc) {
  const lead = asJeeMockTestWhatsAppLead(doc);
  const template = resolveJeeMockTestTemplate(lead);
  if (!template) return { attempted: false, skippedReason: 'utm_not_mapped' };
  if (!isGupshupConfigured()) return { attempted: false, skippedReason: 'gupshup_not_configured' };

  const headerImageLink = resolveJeeMockTestHeaderImageUrl();
  if (!headerImageLink && !isIntegrationStub()) {
    console.warn('[mockTest] WhatsApp skipped: header image URL is missing');
    return { attempted: false, skippedReason: 'header_image_missing' };
  }

  const phone10 = lead.whatsappNumber || lead.contactNumber;
  if (!phone10) return { attempted: false, skippedReason: 'phone_missing' };

  try {
    const templateEnvKey = ensureJeeMockTestTemplateEnv(template);
    const submitGroup = await WhatsAppRetryGroup.create({
      messageKind: template.messageKind,
      cronRunId: null,
      trigger: template.messageKind,
      status: 'open',
    });
    const waResult = await safeSendWhatsApp({
      phone10,
      formSubmissionId: null,
      vars: buildJeeMockTestSubmitVars(lead),
      retryKind: template.messageKind,
      source: template.messageKind,
      cronRunId: null,
      cronJobKey: null,
      sendFn: (phone, vars, sendOpts) =>
        sendJeeMockTestSubmitWhatsApp(phone, vars, {
          ...sendOpts,
          templateId: template.templateId,
          templateEnvKey,
        }),
      retryGroupId: submitGroup._id,
      attemptNumber: 1,
      opsProduct: JEE_MOCK_TEST_OPS_PRODUCT,
      mockTestLeadId: lead._id,
      explicitTemplateEnvKey: templateEnvKey,
    });
    if (waResult && waResult.success) {
      return { attempted: true, success: true, ...(waResult.idempotent ? { idempotent: true } : {}) };
    }
    const errText = waResult && waResult.error ? String(waResult.error).slice(0, 240) : 'send_failed';
    console.warn('[mockTest] WhatsApp jee_mock_test_submit unsuccessful:', errText);
    return { attempted: true, success: false, error: errText };
  } catch (waErr) {
    const msg = String(waErr?.message || waErr || 'exception').slice(0, 240);
    console.error('[mockTest] WhatsApp dispatch error:', msg);
    return { attempted: true, success: false, error: msg };
  }
}

module.exports = {
  dispatchJeeMockTestWhatsApp,
};
