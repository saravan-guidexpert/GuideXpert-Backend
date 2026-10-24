/**
 * JEE mock test registration — Gupshup template chosen by UTM.
 * Body variable is the student's name. Header is an IMAGE (https URL).
 *
 * Most influencer links share one approved template. referp, PRO, and a
 * direct visit with no UTM use a second template. Add another row when a
 * UTM should send a different message. Use a new messageKind only when
 * that message should be its own WhatsApp ops chip.
 */

const GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER = 'GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER';
const GUPSHUP_TEMPLATE_JEE_MOCK_TEST_DIRECT = 'GUPSHUP_TEMPLATE_JEE_MOCK_TEST_DIRECT';

const JEE_MOCK_TEST_INFLUENCER_TEMPLATE_ID = '2df52f62-f55a-4509-8042-2301501fd42a';
const JEE_MOCK_TEST_DIRECT_TEMPLATE_ID = '75c795a8-56fe-467d-a353-f9dc9cc529f5';
const JEE_MOCK_TEST_HEADER_IMAGE_URL =
  'https://res.cloudinary.com/dfqdb1xws/image/upload/v1792824684/WhatsApp_Image_2026-10-24_at_12.16.29_PM_d0s6re.jpg';
const JEE_MOCK_TEST_MESSAGE_KIND = 'jee_mock_test_submit';
const JEE_MOCK_TEST_OPS_PRODUCT = 'jee_mock_test';

const JEE_MOCK_TEST_HEADER_MISSING_ERROR = 'JEE mock test header image URL missing';

function influencerTemplate(source, content, templateId = JEE_MOCK_TEST_INFLUENCER_TEMPLATE_ID, templateEnvKey = GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER) {
  return {
    utm_source: source,
    utm_medium: 'influencer',
    utm_campaign: 'guide_xperts',
    utm_content: content,
    templateId,
    templateEnvKey,
    messageKind: JEE_MOCK_TEST_MESSAGE_KIND,
  };
}

function directTemplate() {
  return {
    templateId: JEE_MOCK_TEST_DIRECT_TEMPLATE_ID,
    templateEnvKey: GUPSHUP_TEMPLATE_JEE_MOCK_TEST_DIRECT,
    messageKind: JEE_MOCK_TEST_MESSAGE_KIND,
  };
}

/** UTM registrations that receive the influencer mock-test WhatsApp. */
const JEE_MOCK_TEST_UTM_TEMPLATES = Object.freeze([
  influencerTemplate('instagram', 'Jayanth'),
  influencerTemplate('instagram', 'Prudhvi'),
  influencerTemplate('instagram', 'Srilekha'),
  influencerTemplate('instagram', 'Rithika'),
  influencerTemplate('instagram', 'referc'),
  influencerTemplate('whatsapp', 'Counsellors'),
  influencerTemplate('instagram', 'referp', JEE_MOCK_TEST_DIRECT_TEMPLATE_ID, GUPSHUP_TEMPLATE_JEE_MOCK_TEST_DIRECT),
  influencerTemplate('whatsapp', 'PRO', JEE_MOCK_TEST_DIRECT_TEMPLATE_ID, GUPSHUP_TEMPLATE_JEE_MOCK_TEST_DIRECT),
]);

function normUtm(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * @param {{ utm_source?: string, utm_medium?: string, utm_campaign?: string, utm_content?: string }} lead
 * @returns {object|null}
 */
function resolveJeeMockTestTemplate(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const source = normUtm(lead.utm_source);
  const medium = normUtm(lead.utm_medium);
  const campaign = normUtm(lead.utm_campaign);
  const content = normUtm(lead.utm_content);
  if (!source && !medium && !campaign && !content) return directTemplate();
  if (!source || !medium || !campaign || !content) return null;
  return (
    JEE_MOCK_TEST_UTM_TEMPLATES.find(
      (row) =>
        normUtm(row.utm_source) === source &&
        normUtm(row.utm_medium) === medium &&
        normUtm(row.utm_campaign) === campaign &&
        normUtm(row.utm_content) === content
    ) || null
  );
}

function resolveJeeMockTestHeaderImageUrl() {
  const url = String(JEE_MOCK_TEST_HEADER_IMAGE_URL || '').trim();
  if (!url || !/^https:\/\//i.test(url)) return null;
  return url;
}

/**
 * safeSendWhatsApp reads the template id from env. Seed the approved id when unset.
 * @param {{ templateEnvKey?: string, templateId?: string }} template
 */
const RETIRED_JEE_MOCK_TEST_TEMPLATE_ID = '816903e2-b795-4b0a-8402-49b59632d778';

function ensureJeeMockTestTemplateEnv(template) {
  const key = template?.templateEnvKey || GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER;
  const fallback = String(template?.templateId || JEE_MOCK_TEST_INFLUENCER_TEMPLATE_ID).trim();
  const current = typeof process.env[key] === 'string' ? process.env[key].trim() : '';
  if (!current || current === RETIRED_JEE_MOCK_TEST_TEMPLATE_ID) {
    process.env[key] = fallback;
  }
  return key;
}

/**
 * Either mock-test lead shape, with the name and phone the template send expects.
 * Homepage registrations store studentName and mobileNumber.
 * @param {object|null|undefined} doc
 */
function asJeeMockTestWhatsAppLead(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const name = String(doc.name || doc.studentName || '').trim();
  const contactNumber = String(doc.contactNumber || doc.mobileNumber || '').trim();
  const whatsappNumber = String(doc.whatsappNumber || '').trim();
  return {
    ...doc,
    name,
    contactNumber,
    whatsappNumber,
  };
}

/**
 * @param {{ name?: string, studentName?: string }} lead
 */
function buildJeeMockTestSubmitVars(lead) {
  const normalized = asJeeMockTestWhatsAppLead(lead);
  const name = String(normalized?.name || '').trim() || 'Student';
  return { name, Name: name };
}

module.exports = {
  GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER,
  GUPSHUP_TEMPLATE_JEE_MOCK_TEST_DIRECT,
  JEE_MOCK_TEST_HEADER_IMAGE_URL,
  JEE_MOCK_TEST_INFLUENCER_TEMPLATE_ID,
  JEE_MOCK_TEST_DIRECT_TEMPLATE_ID,
  JEE_MOCK_TEST_MESSAGE_KIND,
  JEE_MOCK_TEST_OPS_PRODUCT,
  JEE_MOCK_TEST_HEADER_MISSING_ERROR,
  JEE_MOCK_TEST_UTM_TEMPLATES,
  resolveJeeMockTestTemplate,
  resolveJeeMockTestHeaderImageUrl,
  ensureJeeMockTestTemplateEnv,
  asJeeMockTestWhatsAppLead,
  buildJeeMockTestSubmitVars,
};
