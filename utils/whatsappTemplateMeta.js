/**
 * Template env var names per message kind (never log secrets).
 */
const MESSAGE_KIND_TO_ENV_KEY = {
  slot_booked: 'GUPSHUP_TEMPLATE_REMINDER',
  pre4hr: 'GUPSHUP_TEMPLATE_PRE4HR',
  meet: 'GUPSHUP_TEMPLATE_MEET',
  '30min': 'GUPSHUP_TEMPLATE_30MIN',
  one_on_one_submit: 'GUPSHUP_TEMPLATE_ONE_ON_ONE_CONFIRM',
  guidance_booking_submit: 'GUPSHUP_TEMPLATE_GUIDANCE_BOOKING_CONFIRM',
  guidance_pre30min: 'GUPSHUP_TEMPLATE_GUIDANCE_PRE30MIN_REMINDER',
  guidance_counsellor_booking_notify: 'GUPSHUP_TEMPLATE_GUIDANCE_COUNSELLOR_BOOKING_NOTIFY',
  jee_mock_test_submit: 'GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER',
};

function getTemplateMetaForKind(messageKind) {
  const templateIdEnvKey = MESSAGE_KIND_TO_ENV_KEY[messageKind];
  if (!templateIdEnvKey) return { templateIdEnvKey: null, templateId: null };
  const templateId = process.env[templateIdEnvKey] || null;
  return { templateIdEnvKey, templateId };
}

module.exports = {
  MESSAGE_KIND_TO_ENV_KEY,
  getTemplateMetaForKind
};
