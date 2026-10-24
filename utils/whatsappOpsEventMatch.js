/**
 * Shared Mongo match builders for WhatsApp ops (unresolved, manual recovery preview).
 */
const IitCounsellingSubmission = require('../models/IitCounsellingSubmission');
const { parseOpsProductQuery, matchWhatsAppEventsByOpsProduct } = require('./whatsappOpsProduct');

const GX_ONLY_KINDS = ['pre4hr', 'meet', '30min'];
const IIT_ONLY_KINDS = ['iit_pre2hr', 'iit_pre45min', 'iit_pre15min'];
const ONE_ON_ONE_ONLY_KINDS = ['one_on_one_submit'];
const GUIDANCE_BOOKING_ONLY_KINDS = [
  'guidance_booking_submit',
  'guidance_pre30min',
  'guidance_counsellor_booking_notify',
];
const JEE_MOCK_TEST_ONLY_KINDS = ['jee_mock_test_submit'];

function validateMessageKindForOpsProduct(messageKind, opsProduct) {
  if (!messageKind) return null;
  const slug = parseOpsProductQuery(opsProduct);
  const otherProductKinds = [
    ...GX_ONLY_KINDS,
    ...IIT_ONLY_KINDS,
    ...ONE_ON_ONE_ONLY_KINDS,
    ...GUIDANCE_BOOKING_ONLY_KINDS,
    ...JEE_MOCK_TEST_ONLY_KINDS,
  ];
  if (slug === 'iit_counselling' && otherProductKinds.filter((k) => !IIT_ONLY_KINDS.includes(k)).includes(messageKind)) {
    return 'This template is not for IIT Counselling. Switch product or pick an IIT template.';
  }
  if (
    slug === 'guidexpert' &&
    (IIT_ONLY_KINDS.includes(messageKind) ||
      ONE_ON_ONE_ONLY_KINDS.includes(messageKind) ||
      GUIDANCE_BOOKING_ONLY_KINDS.includes(messageKind) ||
      JEE_MOCK_TEST_ONLY_KINDS.includes(messageKind))
  ) {
    return 'This template is not for GuideXpert. Switch product or pick a GuideXpert template.';
  }
  if (slug === 'one_on_one_counseling' && !ONE_ON_ONE_ONLY_KINDS.includes(messageKind)) {
    return 'This template is not for 1-on-1 Counseling. Switch product or pick the form submit template.';
  }
  if (slug === 'guidance_booking' && !GUIDANCE_BOOKING_ONLY_KINDS.includes(messageKind)) {
    return 'This template is not for Guidance Booking. Switch product or pick the booking confirmation template.';
  }
  if (slug === 'jee_mock_test' && !JEE_MOCK_TEST_ONLY_KINDS.includes(messageKind)) {
    return 'This template is not for JEE Mock Test. Switch product or pick the registration template.';
  }
  if (slug === 'iit_counselling' && (GX_ONLY_KINDS.includes(messageKind) || ONE_ON_ONE_ONLY_KINDS.includes(messageKind) || GUIDANCE_BOOKING_ONLY_KINDS.includes(messageKind))) {
    return 'This template is not for IIT Counselling. Switch product or pick an IIT template.';
  }
  return null;
}

/**
 * @returns {Promise<{ match: object, empty: boolean, error?: string }>}
 */
async function buildOpsScopedEventMatch({ messageKind = null, opsProduct = null, preferredLanguage = null } = {}) {
  const kindErr = messageKind ? validateMessageKindForOpsProduct(messageKind, opsProduct) : null;
  if (kindErr) return { match: {}, empty: true, error: kindErr };

  const slug = parseOpsProductQuery(opsProduct);
  const match = { ...matchWhatsAppEventsByOpsProduct(slug) };
  if (messageKind) match.messageKind = messageKind;

  const lang =
    preferredLanguage === 'Telugu' || preferredLanguage === 'Hindi' ? preferredLanguage : null;
  if (slug === 'iit_counselling' && lang) {
    const iitIds = await IitCounsellingSubmission.distinct('_id', {
      'iitCounselling.section2Data.preferredLanguage': lang,
    });
    if (!iitIds.length) {
      return { match, empty: true };
    }
    match.iitCounsellingSubmissionId = { $in: iitIds };
  }

  return { match, empty: false };
}

module.exports = {
  GX_ONLY_KINDS,
  IIT_ONLY_KINDS,
  ONE_ON_ONE_ONLY_KINDS,
  GUIDANCE_BOOKING_ONLY_KINDS,
  JEE_MOCK_TEST_ONLY_KINDS,
  validateMessageKindForOpsProduct,
  buildOpsScopedEventMatch,
};
