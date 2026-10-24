/**
 * Gupshup WhatsApp template messages (wa/api/v1).
 *
 * Env: ENABLE_WHATSAPP, GUPSHUP_API_KEY, GUPSHUP_SOURCE,
 * GUPSHUP_TEMPLATE_REMINDER, GUPSHUP_TEMPLATE_PRE4HR, GUPSHUP_TEMPLATE_MEET,
 * GUPSHUP_TEMPLATE_30MIN, IIT slot_booked templates (see utils/iitCounsellingWhatsApp.js),
 * GUPSHUP_IIT_SLOT_BOOKED_HEADER_IMAGE_URL (IIT IMAGE header),
 * optional GUPSHUP_SRC_NAME
 */
const axios = require('axios');
const {
  SLOT_BOOKED_PARAM_KEYS,
  SLOT_BOOKED_IIT_PARAM_KEYS,
  PRE4HR_PARAM_KEYS,
  MEET_PARAM_KEYS,
  REMINDER_30MIN_PARAM_KEYS,
  buildParamsFromKeys
} = require('../utils/gupshupWhatsAppTemplateParams');
const { buildTemplateField, buildImageMessageField } = require('../utils/gupshupTemplatePayload');
const {
  isIitSlotBookedTemplateEnvKey,
  isIitReminderTemplateEnvKey,
  resolveIitSlotBookedHeaderImageUrl,
  GUPSHUP_IIT_SLOT_BOOKED_HEADER_IMAGE_URL,
} = require('../utils/iitCounsellingWhatsApp');
const { buildIitReminderTemplateParams } = require('../utils/iitReminderWhatsAppSend');
const { parseGupshupTemplateSendResponse } = require('../utils/gupshupMessageIds');
const { isAmbiguousGupshupSendError } = require('../utils/gupshupSendOutcome');
const {
  GUPSHUP_TEMPLATE_ONE_ON_ONE_CONFIRM,
  ONE_ON_ONE_HEADER_MISSING_ERROR,
  resolveOneOnOneHeaderImageUrl,
} = require('../utils/oneOnOneCounselingWhatsApp');
const {
  GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER,
  JEE_MOCK_TEST_INFLUENCER_TEMPLATE_ID,
  JEE_MOCK_TEST_HEADER_MISSING_ERROR,
  resolveJeeMockTestHeaderImageUrl,
} = require('../utils/jeeMockTestWhatsApp');
const {
  GUPSHUP_TEMPLATE_GUIDANCE_BOOKING_CONFIRM,
  GUIDANCE_BOOKING_CONFIRM_PARAM_KEYS,
  GUPSHUP_TEMPLATE_GUIDANCE_PRE30MIN_REMINDER,
  GUIDANCE_PRE30MIN_REMINDER_PARAM_KEYS,
  GUPSHUP_TEMPLATE_GUIDANCE_COUNSELLOR_BOOKING_NOTIFY,
  GUIDANCE_COUNSELLOR_BOOKING_NOTIFY_PARAM_KEYS,
} = require('../utils/guidanceBookingWhatsApp');

const GUPSHUP_TEMPLATE_URL = 'https://api.gupshup.io/wa/api/v1/template/msg';

const IIT_HEADER_MISSING_ERROR =
  `IIT slot_booked header image URL missing (set ${GUPSHUP_IIT_SLOT_BOOKED_HEADER_IMAGE_URL})`;

/** Set WA_IIT_SEND_TRACE=0 to disable verbose IIT outbound payload logs. */
function isIitSendTraceEnabled() {
  return String(process.env.WA_IIT_SEND_TRACE || '1').trim() !== '0';
}

function logWaSendTrace(payload) {
  if (!isIitSendTraceEnabled()) return;
  console.log(JSON.stringify({ event: 'iit_wa_send_trace', ...payload }));
}

let integrationStubCallCount = 0;
let integrationStubFailNext = false;

function isIntegrationStub() {
  return String(process.env.WA_INTEGRATION_STUB || '').trim() === '1';
}

function resetIntegrationStubCallCount() {
  integrationStubCallCount = 0;
  integrationStubFailNext = false;
}

function getIntegrationStubCallCount() {
  return integrationStubCallCount;
}

function setIntegrationStubFailNext(fail = true) {
  integrationStubFailNext = !!fail;
}

function isWhatsAppEnabled() {
  const v = process.env.ENABLE_WHATSAPP;
  if (v == null || String(v).trim() === '') return false;
  const lower = String(v).toLowerCase().trim();
  return !['0', 'false', 'no', 'off'].includes(lower);
}

function isGupshupConfigured() {
  const { isGupshupOutboundConfigured } = require('../utils/gupshupCredentialValidation');
  return isWhatsAppEnabled() && isGupshupOutboundConfigured();
}

function maskPhoneTail(digits) {
  const d = String(digits).replace(/\D/g, '');
  const last4 = d.slice(-4);
  return last4.length === 4 ? `****${last4}` : '****';
}

/**
 * @param {string} phone10OrMore - 10-digit Indian mobile or longer digit string
 * @returns {string} e.g. 91XXXXXXXXXX
 */
function formatPhoneE16491(phone10OrMore) {
  const digits = String(phone10OrMore).replace(/\D/g, '');
  const ten = digits.length >= 10 ? digits.slice(-10) : digits;
  return `91${ten}`;
}

/**
 * Build urlencoded form fields for Gupshup template/msg (exported for unit tests).
 * @param {{ templateId: string, params?: string[], headerImageLink?: string|null, source: string, destination: string, srcName?: string|null, logOutbound?: boolean }} p
 * @returns {Record<string, string>}
 */
function buildTemplateRequestFields(p) {
  const templatePayloadObj = { id: p.templateId, params: p.params || [] };
  const templatePayload = buildTemplateField(templatePayloadObj);
  const messagePayload =
    p.headerImageLink && String(p.headerImageLink).trim()
      ? buildImageMessageField({ link: String(p.headerImageLink).trim() })
      : null;
  const appendMessage = Boolean(messagePayload);

  const body = new URLSearchParams();
  body.append('source', String(p.source).replace(/\D/g, ''));
  body.append('destination', String(p.destination).replace(/\D/g, ''));
  body.append('channel', 'whatsapp');
  body.append('template', templatePayload);
  if (messagePayload) {
    body.append('message', messagePayload);
  }
  if (p.srcName) {
    body.append('src.name', p.srcName);
  }
  const fields = Object.fromEntries(body.entries());

  if (p.logOutbound && isIitSendTraceEnabled()) {
    logWaSendTrace({
      stage: 'buildTemplateRequestFields',
      appendMessage,
      fieldsKeys: Object.keys(fields),
      hasMessageField: Object.prototype.hasOwnProperty.call(fields, 'message'),
      messageField: fields.message || null,
      templateField: fields.template || null,
      bodyString: body.toString()
    });
  }

  return fields;
}

/**
 * @param {string} phoneE164 - destination already 91XXXXXXXXXX
 * @param {string} templateId - Gupshup template id
 * @param {string[]} params - ordered body variable values
 * @param {{ correlationId?: string|null, templateEnvKey?: string|null, headerImageLink?: string|null }} [opts]
 * @returns {Promise<{ success: boolean, data?: unknown, error?: string }>}
 */
async function sendTemplateMessage(phoneE164, templateId, params, opts = {}) {
  const { correlationId, templateEnvKey, headerImageLink } = opts;
  const templateEnvKeyNorm =
    typeof templateEnvKey === 'string' && templateEnvKey.trim() ? templateEnvKey.trim() : null;
  const isIitTemplate = templateEnvKeyNorm && isIitSlotBookedTemplateEnvKey(templateEnvKeyNorm);

  if (isIitTemplate && !headerImageLink && !isIntegrationStub()) {
    console.warn(
      JSON.stringify({
        event: 'gupshup_iit_header_blocked',
        templateEnvKey: templateEnvKeyNorm,
        templateId: templateId || null,
        reason: 'missing_header_image_url'
      })
    );
    return { success: false, error: IIT_HEADER_MISSING_ERROR };
  }

  if (isIntegrationStub()) {
    integrationStubCallCount += 1;
    if (integrationStubFailNext) {
      integrationStubFailNext = false;
      return { success: false, error: 'integration_stub_failure' };
    }
    const crypto = require('crypto');
    const messageId = `test-gs-${crypto.randomUUID()}`;
    return {
      success: true,
      data: { messageId, status: 'submitted', id: messageId }
    };
  }
  if (!isWhatsAppEnabled()) {
    return { success: false, error: 'WhatsApp disabled (ENABLE_WHATSAPP)' };
  }

  const apiKey = process.env.GUPSHUP_API_KEY;
  const source = process.env.GUPSHUP_SOURCE;
  if (!apiKey || !source) {
    console.warn('[Gupshup] Missing GUPSHUP_API_KEY or GUPSHUP_SOURCE');
    return { success: false, error: 'Gupshup not configured' };
  }
  if (!templateId) {
    return { success: false, error: 'template id missing' };
  }

  const destination = String(phoneE164).replace(/\D/g, '');
  const traceOutbound = isIitTemplate || isIitSendTraceEnabled();
  const fields = buildTemplateRequestFields({
    templateId,
    params,
    headerImageLink,
    source,
    destination,
    srcName: process.env.GUPSHUP_SRC_NAME || null,
    logOutbound: traceOutbound
  });
  const body = new URLSearchParams();
  Object.entries(fields).forEach(([k, v]) => body.append(k, v));
  const outboundBodyString = body.toString();

  const templatePayloadObj = { id: templateId, params: params || [] };
  const messagePayloadObj =
    headerImageLink && String(headerImageLink).trim()
      ? { type: 'image', image: { link: String(headerImageLink).trim() } }
      : null;

  const mask = maskPhoneTail(destination);
  console.log(
    JSON.stringify({
      event: 'gupshup_template_send',
      mask,
      templateEnvKey: templateEnvKeyNorm,
      templateId,
      isIitTemplate: Boolean(isIitTemplate),
      isIitSlotBookedEnvKey: templateEnvKeyNorm ? isIitSlotBookedTemplateEnvKey(templateEnvKeyNorm) : false,
      headerType: messagePayloadObj ? 'image' : null,
      headerImageLink: messagePayloadObj ? messagePayloadObj.image.link : null,
      templatePayload: templatePayloadObj,
      messagePayload: messagePayloadObj,
      hasMessageInOutboundBody: outboundBodyString.includes('message='),
      correlationId: correlationId || null
    })
  );

  if (traceOutbound) {
    logWaSendTrace({
      stage: 'sendTemplateMessage_before_axios',
      mask,
      templateEnvKey: templateEnvKeyNorm,
      templateId,
      isIitSlotBookedTemplateEnvKey: templateEnvKeyNorm
        ? isIitSlotBookedTemplateEnvKey(templateEnvKeyNorm)
        : false,
      headerImageLink: headerImageLink || null,
      messagePayload: messagePayloadObj,
      fieldsKeys: Object.keys(fields),
      hasMessageField: Object.prototype.hasOwnProperty.call(fields, 'message'),
      outboundBodyString
    });
  }

  const timeoutMs = isIitTemplate
    ? Math.min(
        Math.max(parseInt(process.env.GUPSHUP_IIT_SEND_TIMEOUT_MS || '', 10) || 60000, 15000),
        120000
      )
    : Math.min(
        Math.max(parseInt(process.env.GUPSHUP_SEND_TIMEOUT_MS || '', 10) || 20000, 5000),
        120000
      );

  try {
    const res = await axios.post(GUPSHUP_TEMPLATE_URL, outboundBodyString, {
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: timeoutMs,
      validateStatus: () => true
    });

    const data = res.data;
    const parsedIds = parseGupshupTemplateSendResponse(data);

    if (correlationId) {
      console.log('[Gupshup] correlationId', correlationId, 'mask', mask, 'template', templateId);
    }

    if (res.status >= 400) {
      const errMsg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
      if (parsedIds.canonicalMessageId) {
        console.warn('[Gupshup] Template HTTP error but message id present', mask, errMsg);
        return { success: true, data, ambiguousAccept: true };
      }
      console.error('[Gupshup] Template send failed', mask, errMsg, data);
      return { success: false, error: String(errMsg), data, httpStatus: res.status };
    }

    if (data && (data.status === 'error' || data.success === false)) {
      const errMsg = data.message || data.error || 'Gupshup API error';
      if (parsedIds.canonicalMessageId) {
        console.warn('[Gupshup] Template rejected in body but message id present', mask, errMsg);
        return { success: true, data, ambiguousAccept: true };
      }
      console.error('[Gupshup] Template send rejected', mask, errMsg, data);
      return { success: false, error: String(errMsg), data, httpStatus: res.status };
    }

    console.log('[Gupshup] Template submitted', mask, templateId);
    return { success: true, data };
  } catch (e) {
    const responseData = e.response && e.response.data ? e.response.data : null;
    const parsedIds = parseGupshupTemplateSendResponse(responseData);
    const msg = responseData
      ? responseData.message || responseData.error || e.message
      : e.message;
    if (parsedIds.canonicalMessageId) {
      console.warn('[Gupshup] Template exception but message id in response', maskPhoneTail(destination), msg);
      return { success: true, data: responseData, ambiguousAccept: true };
    }
    const errText = msg || 'Gupshup request failed';
    if (isIitTemplate && isAmbiguousGupshupSendError(errText)) {
      console.warn('[Gupshup] IIT template ambiguous network error', maskPhoneTail(destination), errText);
    } else {
      console.error('[Gupshup] Template send exception', maskPhoneTail(destination), errText);
    }
    const httpStatus =
      e.response && Number.isFinite(Number(e.response.status)) ? Number(e.response.status) : null;
    return { success: false, error: errText, data: responseData || null, httpStatus };
  }
}

async function sendSlotBookedWhatsApp(phone10, vars, sendOpts = {}) {
  const explicitTemplateEnvKey =
    typeof sendOpts.templateEnvKey === 'string' && sendOpts.templateEnvKey.trim()
      ? sendOpts.templateEnvKey.trim()
      : null;
  const envKey = explicitTemplateEnvKey || 'GUPSHUP_TEMPLATE_REMINDER';
  const tid = process.env[envKey];
  const isIitEnvKey = isIitSlotBookedTemplateEnvKey(envKey);
  const paramKeys = isIitEnvKey ? SLOT_BOOKED_IIT_PARAM_KEYS : SLOT_BOOKED_PARAM_KEYS;
  const params = buildParamsFromKeys(vars, paramKeys);

  let headerImageLink = null;
  if (isIitEnvKey) {
    headerImageLink = resolveIitSlotBookedHeaderImageUrl();
    if (!headerImageLink && !isIntegrationStub()) {
      console.warn(
        JSON.stringify({
          event: 'gupshup_iit_header_blocked',
          templateEnvKey: envKey,
          templateId: tid || null,
          reason: 'missing_header_image_url'
        })
      );
      return { success: false, error: IIT_HEADER_MISSING_ERROR };
    }
    if (isIntegrationStub() && !headerImageLink) {
      headerImageLink = 'https://example.com/iit-stub-header.png';
    }
  }

  logWaSendTrace({
    stage: 'sendSlotBookedWhatsApp_before_sendTemplateMessage',
    mask: maskPhoneTail(phone10),
    explicitTemplateEnvKey,
    finalTemplateEnvKey: envKey,
    templateId: tid || null,
    isIitSlotBookedTemplateEnvKey: isIitEnvKey,
    headerImageLink: headerImageLink || null,
    paramCount: params.length,
    fellBackToReminder: !explicitTemplateEnvKey
  });

  return sendTemplateMessage(formatPhoneE16491(phone10), tid, params, {
    ...sendOpts,
    templateEnvKey: envKey,
    headerImageLink
  });
}

async function sendPre4HrReminderWhatsApp(phone10, vars, sendOpts = {}) {
  const tid = process.env.GUPSHUP_TEMPLATE_PRE4HR;
  const params = buildParamsFromKeys(vars, PRE4HR_PARAM_KEYS);
  return sendTemplateMessage(formatPhoneE16491(phone10), tid, params, sendOpts);
}

async function sendMeetLinkWhatsApp(phone10, vars, sendOpts = {}) {
  const tid = process.env.GUPSHUP_TEMPLATE_MEET;
  const params = buildParamsFromKeys(vars, MEET_PARAM_KEYS);
  return sendTemplateMessage(formatPhoneE16491(phone10), tid, params, sendOpts);
}

async function sendReminder30MinWhatsApp(phone10, vars, sendOpts = {}) {
  const tid = process.env.GUPSHUP_TEMPLATE_30MIN;
  const params = buildParamsFromKeys(vars, REMINDER_30MIN_PARAM_KEYS);
  return sendTemplateMessage(formatPhoneE16491(phone10), tid, params, sendOpts);
}

/** IIT counselling reminders: template env key must be passed via sendOpts.templateEnvKey */
async function sendIitReminderWhatsApp(phone10, vars, sendOpts = {}) {
  const envKey =
    typeof sendOpts.templateEnvKey === 'string' && sendOpts.templateEnvKey.trim()
      ? sendOpts.templateEnvKey.trim()
      : null;
  const tid = envKey ? process.env[envKey] : null;
  const messageKind =
    typeof sendOpts.messageKind === 'string' && sendOpts.messageKind.trim()
      ? sendOpts.messageKind.trim()
      : 'iit_pre2hr';
  const attemptNumber = Math.min(
    6,
    Math.max(1, parseInt(String(sendOpts.attemptNumber || 1), 10) || 1)
  );
  const params = buildIitReminderTemplateParams(vars, messageKind, attemptNumber);

  let headerImageLink = null;
  if (messageKind === 'iit_pre2hr') {
    const pre2hrHeader = process.env.GUPSHUP_IIT_PRE2HR_HEADER_IMAGE_URL;
    if (typeof pre2hrHeader === 'string' && pre2hrHeader.trim()) {
      headerImageLink = pre2hrHeader.trim();
    }
  }

  return sendTemplateMessage(formatPhoneE16491(phone10), tid, params, {
    ...sendOpts,
    templateEnvKey: envKey,
    headerImageLink,
  });
}

/** 1-on-1 counseling form submit: name body + IMAGE header. */
async function sendOneOnOneSubmitWhatsApp(phone10, vars, sendOpts = {}) {
  const envKey =
    typeof sendOpts.templateEnvKey === 'string' && sendOpts.templateEnvKey.trim()
      ? sendOpts.templateEnvKey.trim()
      : GUPSHUP_TEMPLATE_ONE_ON_ONE_CONFIRM;
  const tid = process.env[envKey];
  const params = buildParamsFromKeys(vars, SLOT_BOOKED_IIT_PARAM_KEYS);

  let headerImageLink = resolveOneOnOneHeaderImageUrl();
  if (!headerImageLink && !isIntegrationStub()) {
    return { success: false, error: ONE_ON_ONE_HEADER_MISSING_ERROR };
  }
  if (isIntegrationStub() && !headerImageLink) {
    headerImageLink = 'https://example.com/one-on-one-stub-header.png';
  }

  return sendTemplateMessage(formatPhoneE16491(phone10), tid, params, {
    ...sendOpts,
    templateEnvKey: envKey,
    headerImageLink,
  });
}

/** JEE mock test registration: name body + IMAGE header. Template id comes from the UTM map. */
async function sendJeeMockTestSubmitWhatsApp(phone10, vars, sendOpts = {}) {
  const envKey =
    typeof sendOpts.templateEnvKey === 'string' && sendOpts.templateEnvKey.trim()
      ? sendOpts.templateEnvKey.trim()
      : GUPSHUP_TEMPLATE_JEE_MOCK_TEST_INFLUENCER;
  const explicitId =
    typeof sendOpts.templateId === 'string' && sendOpts.templateId.trim() ? sendOpts.templateId.trim() : '';
  const tid = explicitId || process.env[envKey] || JEE_MOCK_TEST_INFLUENCER_TEMPLATE_ID;
  const params = buildParamsFromKeys(vars, SLOT_BOOKED_IIT_PARAM_KEYS);

  let headerImageLink = resolveJeeMockTestHeaderImageUrl();
  if (!headerImageLink && !isIntegrationStub()) {
    return { success: false, error: JEE_MOCK_TEST_HEADER_MISSING_ERROR };
  }
  if (isIntegrationStub() && !headerImageLink) {
    headerImageLink = 'https://example.com/jee-mock-test-stub-header.png';
  }

  return sendTemplateMessage(formatPhoneE16491(phone10), tid, params, {
    ...sendOpts,
    templateEnvKey: envKey,
    headerImageLink,
  });
}

/** Guidance booking confirmation: date + time body (no header image). */
async function sendGuidanceBookingSubmitWhatsApp(phone10, vars, sendOpts = {}) {
  const envKey =
    typeof sendOpts.templateEnvKey === 'string' && sendOpts.templateEnvKey.trim()
      ? sendOpts.templateEnvKey.trim()
      : GUPSHUP_TEMPLATE_GUIDANCE_BOOKING_CONFIRM;
  const tid = process.env[envKey];
  const params = buildParamsFromKeys(vars, GUIDANCE_BOOKING_CONFIRM_PARAM_KEYS);
  return sendTemplateMessage(formatPhoneE16491(phone10), tid, params, {
    ...sendOpts,
    templateEnvKey: envKey,
  });
}

/** Guidance session 30-minute reminder: name + slottime body. */
async function sendGuidancePre30MinReminderWhatsApp(phone10, vars, sendOpts = {}) {
  const envKey =
    typeof sendOpts.templateEnvKey === 'string' && sendOpts.templateEnvKey.trim()
      ? sendOpts.templateEnvKey.trim()
      : GUPSHUP_TEMPLATE_GUIDANCE_PRE30MIN_REMINDER;
  const tid = process.env[envKey];
  const params = buildParamsFromKeys(vars, GUIDANCE_PRE30MIN_REMINDER_PARAM_KEYS);
  return sendTemplateMessage(formatPhoneE16491(phone10), tid, params, {
    ...sendOpts,
    templateEnvKey: envKey,
  });
}

/** Guidance counsellor booking notify: student name + date + time + counsellor name. */
async function sendGuidanceCounsellorBookingNotifyWhatsApp(phone10, vars, sendOpts = {}) {
  const envKey =
    typeof sendOpts.templateEnvKey === 'string' && sendOpts.templateEnvKey.trim()
      ? sendOpts.templateEnvKey.trim()
      : GUPSHUP_TEMPLATE_GUIDANCE_COUNSELLOR_BOOKING_NOTIFY;
  const tid = process.env[envKey];
  const params = buildParamsFromKeys(vars, GUIDANCE_COUNSELLOR_BOOKING_NOTIFY_PARAM_KEYS);
  return sendTemplateMessage(formatPhoneE16491(phone10), tid, params, {
    ...sendOpts,
    templateEnvKey: envKey,
  });
}

module.exports = {
  isWhatsAppEnabled,
  isGupshupConfigured,
  formatPhoneE16491,
  buildTemplateRequestFields,
  sendTemplateMessage,
  sendSlotBookedWhatsApp,
  sendPre4HrReminderWhatsApp,
  sendMeetLinkWhatsApp,
  sendReminder30MinWhatsApp,
  sendIitReminderWhatsApp,
  sendOneOnOneSubmitWhatsApp,
  sendJeeMockTestSubmitWhatsApp,
  sendGuidanceBookingSubmitWhatsApp,
  sendGuidancePre30MinReminderWhatsApp,
  sendGuidanceCounsellorBookingNotifyWhatsApp,
  isIitReminderTemplateEnvKey,
  resetIntegrationStubCallCount,
  getIntegrationStubCallCount,
  setIntegrationStubFailNext,
  isIntegrationStub,
  IIT_HEADER_MISSING_ERROR
};
