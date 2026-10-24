/**
 * Ops overview product dimension for WhatsAppMessageEvent filtering.
 * Legacy rows omit opsProduct → treated as GuideXpert.
 */

const DEFAULT_OPS_PRODUCT = 'guidexpert';
const ALLOWED_OPS_PRODUCTS = Object.freeze([
  'guidexpert',
  'iit_counselling',
  'one_on_one_counseling',
  'guidance_booking',
  'jee_mock_test',
]);

/** @returns {readonly string[]} */
function listAllowedOpsProducts() {
  return ALLOWED_OPS_PRODUCTS;
}

/**
 * Parse query/header string into a normalized ops product slug.
 * Invalid values fall back to `guidexpert`.
 * @param {unknown} raw
 */
function parseOpsProductQuery(raw) {
  const s = raw == null ? '' : String(raw).trim().toLowerCase().replace(/-/g, '_');
  if (s === 'iit_counselling' || s === 'iitcounselling') return 'iit_counselling';
  if (
    s === 'one_on_one_counseling' ||
    s === 'one_on_one' ||
    s === 'oneonone' ||
    s === 'one_on_one_session'
  ) {
    return 'one_on_one_counseling';
  }
  if (
    s === 'guidance_booking' ||
    s === 'guidance_booking_confirmation' ||
    s === 'guidancebooking'
  ) {
    return 'guidance_booking';
  }
  if (s === 'jee_mock_test' || s === 'jeemocktest' || s === 'mock_test' || s === 'mocktest') {
    return 'jee_mock_test';
  }
  return DEFAULT_OPS_PRODUCT;
}

/** For GuideXpert, include legacy docs with missing/null opsProduct. */
const GUIDEXPERT_EVENT_MATCH_FRAGMENT = Object.freeze({
  $or: [
    { opsProduct: { $exists: false } },
    { opsProduct: null },
    { opsProduct: 'guidexpert' }
  ]
});

/** @returns {object} fragment to merge into a Mongo `$match` (AND with other predicates) */
function matchWhatsAppEventsByOpsProduct(slug) {
  if (slug === 'iit_counselling') {
    return { opsProduct: 'iit_counselling' };
  }
  if (slug === 'one_on_one_counseling') {
    return { opsProduct: 'one_on_one_counseling' };
  }
  if (slug === 'guidance_booking') {
    return { opsProduct: 'guidance_booking' };
  }
  if (slug === 'jee_mock_test') {
    return { opsProduct: 'jee_mock_test' };
  }
  return { ...GUIDEXPERT_EVENT_MATCH_FRAGMENT };
}

/**
 * Persisted / outbound events: explicit slug or GuideXpert default.
 * @param {unknown} raw
 */
function normalizeOutboundOpsProduct(raw) {
  if (raw === 'iit_counselling') return 'iit_counselling';
  if (raw === 'one_on_one_counseling') return 'one_on_one_counseling';
  if (raw === 'guidance_booking') return 'guidance_booking';
  if (raw === 'jee_mock_test') return 'jee_mock_test';
  return DEFAULT_OPS_PRODUCT;
}

/**
 * @param {unknown} opsProductRaw
 * @param {string|null} messageKind
 * @returns {string|null}
 */
function effectiveOverviewMessageKind(opsProductRaw, messageKind) {
  return messageKind || null;
}

module.exports = {
  DEFAULT_OPS_PRODUCT,
  ALLOWED_OPS_PRODUCTS,
  listAllowedOpsProducts,
  parseOpsProductQuery,
  normalizeOutboundOpsProduct,
  effectiveOverviewMessageKind,
  matchWhatsAppEventsByOpsProduct,
  GUIDEXPERT_EVENT_MATCH_FRAGMENT
};
