const axios = require('axios');

const MSG91_SEND_OTP_URL = 'https://control.msg91.com/api/v5/otp';
const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow';

function buildRecipients(phones, variables = {}) {
  return phones.map(phone => {
    const digits = String(phone).replace(/\D/g, '');
    const mobile = digits.length >= 10 ? '91' + digits.slice(-10) : '91' + digits;
    return { mobiles: mobile, ...variables };
  });
}

/**
 * Send OTP via MSG91 SMS API (control.msg91.com).
 * @param {string} phone - 10-digit Indian number (no 91)
 * @param {string} otp - 6-digit OTP to send
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendOtp(phone, otp) {
  const authkey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  const otpExpiry = Number(process.env.OTP_EXPIRY_MINUTES) || 5;

  if (!authkey || !templateId) {
    return { success: false, error: 'MSG91 not configured' };
  }

  const digits = String(phone).replace(/\D/g, '');
  const mobile = digits.length >= 10 ? '91' + digits.slice(-10) : '91' + digits;

  // 1. If template is 24 hex characters (Flow/Campaign template), try Flow API first
  if (templateId.length === 24) {
    try {
      const flowRes = await sendOtpViaFlow(phone, otp);
      if (flowRes.success) {
        logSendResult(phone, true, JSON.stringify(flowRes.details));
        return { success: true, details: flowRes.details, provider: 'flow' };
      }
      console.warn('[MSG91] Flow send failed, trying OTP API fallback:', flowRes.error);
    } catch (flowErr) {
      console.warn('[MSG91] Flow send exception, falling back to OTP API:', flowErr.message);
    }
  }

  // URL parameters for compatibility
  const params = new URLSearchParams({
    mobile,
    authkey,
    otp_expiry: String(otpExpiry),
    template_id: templateId,
    otp: String(otp)
  });

  const url = `${MSG91_SEND_OTP_URL}?${params.toString()}`;
  const requestBody = {
    template_id: templateId,
    mobile,
    otp: String(otp),
    otp_expiry: String(otpExpiry)
  };

  try {
    // 2. Try standard MSG91 v5 POST with authkey header & JSON payload
    const postRes = await axios.post(url, requestBody, {
      headers: {
        'authkey': authkey,
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true
    });

    console.log('[MSG91] Send OTP POST response:', {
      status: postRes.status,
      data: postRes.data,
      templateIdPrefix: templateId.slice(0, 4) + '***',
      templateIdLen: templateId.length,
      mobile: `****${mobile.slice(-4)}`
    });

    if (postRes.status >= 200 && postRes.status < 400) {
      const data = postRes.data || {};
      if (data.type !== 'error' && data.status !== 'error' && data.success !== false) {
        logSendResult(phone, true, JSON.stringify(data));
        return { success: true, details: data };
      }
    }

    // 2. Fallback to GET for legacy or custom MSG91 endpoints
    const getRes = await axios.get(url, {
      headers: {
        'authkey': authkey,
        'accept': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true
    });

    console.log('[MSG91] Send OTP GET response:', {
      status: getRes.status,
      data: getRes.data
    });

    if (getRes.status >= 400) {
      const err = (getRes.data && (getRes.data.message || getRes.data.error)) || `API returned ${getRes.status}`;
      logSendResult(phone, false, err);
      return { success: false, error: String(err), details: getRes.data };
    }

    const data = getRes.data || {};
    if (data.type === 'error' || data.status === 'error' || data.success === false) {
      const err = data.message || data.error || 'MSG91 error';
      logSendResult(phone, false, err);
      return { success: false, error: String(err), details: data };
    }

    logSendResult(phone, true, JSON.stringify(data));
    return { success: true, details: data };
  } catch (e) {
    const msg = e.response && e.response.data
      ? (e.response.data.message || e.response.data.error)
      : e.message;
    logSendResult(phone, false, msg);
    return { success: false, error: msg || 'Failed to send OTP' };
  }
}

/**
 * Log send result without sensitive data (no OTP, no full mobile).
 */
function logSendResult(phone, success, detail) {
  const last4 = String(phone).replace(/\D/g, '').slice(-4);
  const mask = last4.length === 4 ? `****${last4}` : '****';
  if (success) {
    console.log('[MSG91] Send OTP success for', mask);
  } else {
    console.warn('[MSG91] Send OTP failed for', mask, detail || '');
  }
}

/**
 * Send Slot Confirmation SMS via MSG91 Flow API (transactional SMS).
 * Uses the same template-based approach as OTP but for notifications.
 * @param {string} phone - 10-digit Indian number (no 91)
 * @param {Object} variables - Template variables (name, date, time will be mapped to template vars)
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendSlotConfirmationSms(phone, variables = {}) {
  const authkey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_SLOT_CONFIRMATION_TEMPLATE_ID;

  if (!authkey || !templateId) {
    console.warn('[MSG91] Slot confirmation SMS not configured (missing AUTH_KEY or SLOT_CONFIRMATION_TEMPLATE_ID)');
    return { success: false, error: 'MSG91 slot confirmation not configured' };
  }

  console.log('[MSG91] Sending slot confirmation SMS:', {
    mobile: `****${String(phone).replace(/\D/g, '').slice(-4)}`,
    templateId,
    variables
  });

  const recipients = buildRecipients([phone], {
    // If your template uses ##name##, ##date##, ##time##, use those exact keys
    name: variables.name || '',
    date: variables.date || '',
    time: variables.time || ''
  });

  // Build request body for MSG91 Flow API (new format)
  const requestBody = {
    template_id: templateId,
    recipients
  };

  try {
    const res = await axios.post(MSG91_FLOW_URL, requestBody, {
      headers: {
        'accept': 'application/json',
        'authkey': authkey,
        'content-type': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true
    });

    console.log('[MSG91] Flow API response:', {
      status: res.status,
      data: res.data
    });

    if (res.status >= 400) {
      const err = (res.data && (res.data.message || res.data.error)) || `API returned ${res.status}`;
      logSlotSmsResult(phone, false, err);
      return { success: false, error: String(err) };
    }

    const data = res.data || {};
    if (data.type === 'error' || data.status === 'error' || data.success === false) {
      const err = data.message || data.error || 'MSG91 error';
      logSlotSmsResult(phone, false, err);
      return { success: false, error: String(err) };
    }

    logSlotSmsResult(phone, true);
    return { success: true };
  } catch (e) {
    const msg = e.response && e.response.data
      ? (e.response.data.message || e.response.data.error)
      : e.message;
    console.error('[MSG91] Flow API exception:', e.message);
    logSlotSmsResult(phone, false, msg);
    return { success: false, error: msg || 'Failed to send slot confirmation SMS' };
  }
}

/**
 * Log slot SMS result without sensitive data.
 */
function logSlotSmsResult(phone, success, detail) {
  const last4 = String(phone).replace(/\D/g, '').slice(-4);
  const mask = last4.length === 4 ? `****${last4}` : '****';
  if (success) {
    console.log('[MSG91] Slot confirmation SMS sent successfully for', mask);
  } else {
    console.warn('[MSG91] Slot confirmation SMS failed for', mask, detail || '');
  }
}

/**
 * Send Reminder SMS to multiple users via MSG91 Flow API.
 * Used by cron job to send bulk reminders 4 hours before slot.
 * @param {Array<string>} phones - Array of 10-digit Indian phone numbers
 * @param {Object} variables - Template variables (optional, e.g., { date, time })
 * @returns {Promise<{ success: boolean, sentCount: number, failedCount: number, error?: string }>}
 */
async function sendBulkReminderSms(phones, variables = {}) {
  const authkey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_REMINDER_TEMPLATE_ID;

  if (!authkey || !templateId) {
    console.warn('[MSG91] Reminder SMS not configured (missing AUTH_KEY or REMINDER_TEMPLATE_ID)');
    return { success: false, sentCount: 0, failedCount: phones.length, error: 'MSG91 reminder not configured' };
  }

  if (!phones || phones.length === 0) {
    console.warn('[MSG91] No phone numbers provided for bulk reminder');
    return { success: true, sentCount: 0, failedCount: 0 };
  }

  const recipients = buildRecipients(phones, variables);

  console.log('[MSG91] Sending bulk reminder SMS:', {
    count: phones.length,
    templateId,
    variables
  });

  // Build request body for MSG91 Flow API (new format)
  const requestBody = {
    template_id: templateId,
    recipients
  };

  try {
    const res = await axios.post(MSG91_FLOW_URL, requestBody, {
      headers: {
        'accept': 'application/json',
        'authkey': authkey,
        'content-type': 'application/json'
      },
      timeout: 30000, // Longer timeout for bulk
      validateStatus: () => true
    });

    console.log('[MSG91] Bulk reminder API response:', {
      status: res.status,
      data: res.data
    });

    if (res.status >= 400) {
      const err = (res.data && (res.data.message || res.data.error)) || `API returned ${res.status}`;
      console.error('[MSG91] Bulk reminder failed:', err);
      return { success: false, sentCount: 0, failedCount: phones.length, error: String(err) };
    }

    const data = res.data || {};
    if (data.type === 'error' || data.status === 'error' || data.success === false) {
      const err = data.message || data.error || 'MSG91 error';
      console.error('[MSG91] Bulk reminder failed:', err);
      return { success: false, sentCount: 0, failedCount: phones.length, error: String(err) };
    }

    console.log('[MSG91] Bulk reminder SMS sent successfully to', phones.length, 'users');
    return { success: true, sentCount: phones.length, failedCount: 0 };
  } catch (e) {
    const msg = e.response && e.response.data
      ? (e.response.data.message || e.response.data.error)
      : e.message;
    console.error('[MSG91] Bulk reminder API exception:', e.message);
    return { success: false, sentCount: 0, failedCount: phones.length, error: msg || 'Failed to send bulk reminder SMS' };
  }
}

/**
 * Send single Reminder SMS via MSG91 Flow API.
 * Used for immediate reminder when user books within 4 hours of slot.
 * @param {string} phone - 10-digit Indian phone number
 * @param {Object} variables - Template variables (optional, e.g., { name, date, time })
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendReminderSms(phone, variables = {}) {
  const result = await sendBulkReminderSms([phone], variables);
  return { success: result.success, error: result.error };
}

/**
 * Send Meet Link SMS to multiple users via MSG91 Flow API.
 * Used by cron job to send bulk meet links 1 hour before slot.
 * @param {Array<string>} phones - Array of 10-digit Indian phone numbers
 * @param {Object} variables - Template variables (optional, e.g., { meetLink })
 * @returns {Promise<{ success: boolean, sentCount: number, failedCount: number, error?: string }>}
 */
async function sendBulkMeetLinkSms(phones, variables = {}) {
  const authkey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_MEETLINK_TEMPLATE_ID;

  if (!authkey || !templateId) {
    console.warn('[MSG91] Meet Link SMS not configured (missing AUTH_KEY or MEETLINK_TEMPLATE_ID)');
    return { success: false, sentCount: 0, failedCount: phones.length, error: 'MSG91 meet link not configured' };
  }

  if (!phones || phones.length === 0) {
    console.warn('[MSG91] No phone numbers provided for bulk meet link');
    return { success: true, sentCount: 0, failedCount: 0 };
  }

  const recipients = buildRecipients(phones, variables);

  console.log('[MSG91] Sending bulk meet link SMS:', {
    count: phones.length,
    templateId,
    variables
  });

  // Build request body for MSG91 Flow API (new format)
  const requestBody = {
    template_id: templateId,
    recipients
  };

  try {
    const res = await axios.post(MSG91_FLOW_URL, requestBody, {
      headers: {
        'accept': 'application/json',
        'authkey': authkey,
        'content-type': 'application/json'
      },
      timeout: 30000,
      validateStatus: () => true
    });

    console.log('[MSG91] Bulk meet link API response:', {
      status: res.status,
      data: res.data
    });

    if (res.status >= 400) {
      const err = (res.data && (res.data.message || res.data.error)) || `API returned ${res.status}`;
      console.error('[MSG91] Bulk meet link failed:', err);
      return { success: false, sentCount: 0, failedCount: phones.length, error: String(err) };
    }

    const data = res.data || {};
    if (data.type === 'error' || data.status === 'error' || data.success === false) {
      const err = data.message || data.error || 'MSG91 error';
      console.error('[MSG91] Bulk meet link failed:', err);
      return { success: false, sentCount: 0, failedCount: phones.length, error: String(err) };
    }

    console.log('[MSG91] Bulk meet link SMS sent successfully to', phones.length, 'users');
    return { success: true, sentCount: phones.length, failedCount: 0 };
  } catch (e) {
    const msg = e.response && e.response.data
      ? (e.response.data.message || e.response.data.error)
      : e.message;
    console.error('[MSG91] Bulk meet link API exception:', e.message);
    return { success: false, sentCount: 0, failedCount: phones.length, error: msg || 'Failed to send bulk meet link SMS' };
  }
}

/**
 * Send single Meet Link SMS via MSG91 Flow API.
 * Used for immediate meet link when user books within 1 hour of slot.
 * @param {string} phone - 10-digit Indian phone number
 * @param {Object} variables - Template variables (optional, e.g., { meetLink })
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendMeetLinkSms(phone, variables = {}) {
  const result = await sendBulkMeetLinkSms([phone], variables);
  return { success: result.success, error: result.error };
}

/**
 * Send 30-Min Live Reminder SMS to multiple users via MSG91 Flow API.
 * Used by cron job to send bulk reminders 30 minutes before slot.
 * @param {Array<string>} phones - Array of 10-digit Indian phone numbers
 * @param {Object} variables - Template variables (e.g., { var: meetLink })
 * @returns {Promise<{ success: boolean, sentCount: number, failedCount: number, error?: string }>}
 */
async function sendBulkReminder30MinSms(phones, variables = {}) {
  const authkey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_30MIN_REMINDER_TEMPLATE_ID;

  if (!authkey || !templateId) {
    console.warn('[MSG91] 30-Min Reminder SMS not configured (missing AUTH_KEY or 30MIN_REMINDER_TEMPLATE_ID)');
    return { success: false, sentCount: 0, failedCount: phones.length, error: 'MSG91 30-min reminder not configured' };
  }

  if (!phones || phones.length === 0) {
    console.warn('[MSG91] No phone numbers provided for bulk 30-min reminder');
    return { success: true, sentCount: 0, failedCount: 0 };
  }

  const recipients = buildRecipients(phones, variables);

  console.log('[MSG91] Sending bulk 30-min reminder SMS:', {
    count: phones.length,
    templateId,
    variables
  });

  // Build request body for MSG91 Flow API (new format)
  const requestBody = {
    template_id: templateId,
    recipients
  };

  try {
    const res = await axios.post(MSG91_FLOW_URL, requestBody, {
      headers: {
        'accept': 'application/json',
        'authkey': authkey,
        'content-type': 'application/json'
      },
      timeout: 30000,
      validateStatus: () => true
    });

    console.log('[MSG91] Bulk 30-min reminder API response:', {
      status: res.status,
      data: res.data
    });

    if (res.status >= 400) {
      const err = (res.data && (res.data.message || res.data.error)) || `API returned ${res.status}`;
      console.error('[MSG91] Bulk 30-min reminder failed:', err);
      return { success: false, sentCount: 0, failedCount: phones.length, error: String(err) };
    }

    const data = res.data || {};
    if (data.type === 'error' || data.status === 'error' || data.success === false) {
      const err = data.message || data.error || 'MSG91 error';
      console.error('[MSG91] Bulk 30-min reminder failed:', err);
      return { success: false, sentCount: 0, failedCount: phones.length, error: String(err) };
    }

    console.log('[MSG91] Bulk 30-min reminder SMS sent successfully to', phones.length, 'users');
    return { success: true, sentCount: phones.length, failedCount: 0 };
  } catch (e) {
    const msg = e.response && e.response.data
      ? (e.response.data.message || e.response.data.error)
      : e.message;
    console.error('[MSG91] Bulk 30-min reminder API exception:', e.message);
    return { success: false, sentCount: 0, failedCount: phones.length, error: msg || 'Failed to send bulk 30-min reminder SMS' };
  }
}

/**
 * Send single 30-Min Live Reminder SMS via MSG91 Flow API.
 * Used for immediate 30-min reminder when user books within 30 min of slot.
 * @param {string} phone - 10-digit Indian phone number
 * @param {Object} variables - Template variables (e.g., { var: meetLink })
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function sendReminder30MinSms(phone, variables = {}) {
  const result = await sendBulkReminder30MinSms([phone], variables);
  return { success: result.success, error: result.error };
}

/**
 * IIT counselling Telugu reminder SMS via MSG91 Flow (isolated from GX demo templates).
 * @param {string} phone - 10-digit Indian number
 * @param {string} templateId - DLT template id
 * @param {Object} variables - Flow recipient vars (name, date, time, var, …)
 * @returns {Promise<{ success: boolean, error?: string, response?: object }>}
 */
async function sendIitTeluguFlowSms(phone, templateId, variables = {}) {
  const authkey = process.env.MSG91_AUTH_KEY;
  if (!authkey) {
    return { success: false, error: 'MSG91 not configured' };
  }
  if (!templateId) {
    return { success: false, error: 'MSG91 IIT Telugu template id missing' };
  }

  const recipients = buildRecipients([phone], variables);
  const requestBody = { template_id: String(templateId), recipients };

  try {
    const res = await axios.post(MSG91_FLOW_URL, requestBody, {
      headers: {
        accept: 'application/json',
        authkey,
        'content-type': 'application/json',
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (res.status >= 400) {
      const err = (res.data && (res.data.message || res.data.error)) || `API returned ${res.status}`;
      return { success: false, error: String(err), response: res.data };
    }

    const data = res.data || {};
    if (data.type === 'error' || data.status === 'error' || data.success === false) {
      const err = data.message || data.error || 'MSG91 error';
      return { success: false, error: String(err), response: data };
    }

    return { success: true, response: data };
  } catch (e) {
    const msg =
      e.response && e.response.data
        ? e.response.data.message || e.response.data.error
        : e.message;
    return { success: false, error: msg || 'Failed to send IIT Telugu SMS' };
  }
}

/**
 * Send OTP via MSG91 Flow API (alternative to OTP endpoint for Flow templates).
 * Passes otp, OTP, code in template variables.
 */
async function sendOtpViaFlow(phone, otp) {
  const authkey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;

  if (!authkey || !templateId) {
    return { success: false, error: 'MSG91 not configured' };
  }

  const digits = String(phone).replace(/\D/g, '');
  const mobile = digits.length >= 10 ? '91' + digits.slice(-10) : '91' + digits;

  const recipients = [
    {
      mobiles: mobile,
      otp: String(otp),
      OTP: String(otp),
      code: String(otp),
      number: String(otp)
    }
  ];

  const requestBody = {
    template_id: templateId,
    recipients
  };

  try {
    const res = await axios.post(MSG91_FLOW_URL, requestBody, {
      headers: {
        accept: 'application/json',
        authkey,
        'content-type': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true
    });

    console.log('[MSG91] Send OTP Flow response:', {
      status: res.status,
      data: res.data
    });

    if (res.status >= 200 && res.status < 400) {
      const data = res.data || {};
      if (data.type !== 'error' && data.status !== 'error' && data.success !== false) {
        return { success: true, details: data };
      }
    }
    return { success: false, error: res.data?.message || `Flow returned ${res.status}`, details: res.data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function sendOtpDirect(phone, otp) {
  const authkey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  const otpExpiry = Number(process.env.OTP_EXPIRY_MINUTES) || 5;

  if (!authkey || !templateId) {
    return { success: false, error: 'MSG91 not configured' };
  }

  const digits = String(phone).replace(/\D/g, '');
  const mobile = digits.length >= 10 ? '91' + digits.slice(-10) : '91' + digits;

  const params = new URLSearchParams({
    mobile,
    authkey,
    otp_expiry: String(otpExpiry),
    template_id: templateId,
    otp: String(otp)
  });

  const url = `${MSG91_SEND_OTP_URL}?${params.toString()}`;
  const requestBody = {
    template_id: templateId,
    mobile,
    otp: String(otp),
    otp_expiry: String(otpExpiry)
  };

  try {
    const postRes = await axios.post(url, requestBody, {
      headers: {
        'authkey': authkey,
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true
    });
    return { status: postRes.status, data: postRes.data, url: MSG91_SEND_OTP_URL };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Diagnostic helper to inspect MSG91 credits, delivery logs, and template settings.
 */
async function getMsg91Diagnostics(phoneFilter) {
  const authkey = process.env.MSG91_AUTH_KEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;

  if (!authkey) {
    return { configured: false, error: 'MSG91_AUTH_KEY missing' };
  }

  const results = {
    configured: true,
    authKeyPrefix: authkey.slice(0, 4) + '***',
    authKeyLen: authkey.length,
    templateIdPrefix: templateId ? templateId.slice(0, 4) + '***' : 'missing',
    templateIdLen: templateId ? templateId.length : 0,
    timestamp: new Date().toISOString()
  };

  const headers = {
    authkey,
    accept: 'application/json'
  };

  // 1. Check account credits
  try {
    const accRes = await axios.get('https://control.msg91.com/api/v1/account', {
      headers,
      timeout: 5000,
      validateStatus: () => true
    });
    results.account = { status: accRes.status, data: accRes.data };
  } catch (e) {
    results.account = { error: e.message };
  }

  // 1b. Check balance using MSG91 balance endpoints
  try {
    const balRes = await axios.get(`https://api.msg91.com/api/balance.php?authkey=${authkey}&type=4`, {
      timeout: 5000,
      validateStatus: () => true
    });
    results.balanceTransactional = { status: balRes.status, data: balRes.data };
  } catch (e) {
    results.balanceTransactional = { error: e.message };
  }

  try {
    const balRes1 = await axios.get(`https://api.msg91.com/api/balance.php?authkey=${authkey}&type=1`, {
      timeout: 5000,
      validateStatus: () => true
    });
    results.balancePromotional = { status: balRes1.status, data: balRes1.data };
  } catch (e) {
    results.balancePromotional = { error: e.message };
  }

  // 2. Query OTP delivery logs (last 3 days)
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const threeDaysAgo = new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);

  try {
    const otpLogsRes = await axios.get(
      `https://control.msg91.com/api/v5/report/logs/p/otp?startDate=${threeDaysAgo}&endDate=${todayStr}`,
      { headers, timeout: 8000, validateStatus: () => true }
    );
    let logData = otpLogsRes.data;
    if (phoneFilter && Array.isArray(logData?.data)) {
      const pDigits = String(phoneFilter).slice(-6);
      logData = logData.data.filter(item => JSON.stringify(item).includes(pDigits));
    }
    results.otpLogs = { status: otpLogsRes.status, data: logData };
  } catch (e) {
    results.otpLogs = { error: e.message };
  }

  // 3. Query SMS delivery logs
  try {
    const smsLogsRes = await axios.get(
      `https://control.msg91.com/api/v5/report/logs/sms?startDate=${threeDaysAgo}&endDate=${todayStr}`,
      { headers, timeout: 8000, validateStatus: () => true }
    );
    let logData = smsLogsRes.data;
    if (phoneFilter && Array.isArray(logData?.data)) {
      const pDigits = String(phoneFilter).slice(-6);
      logData = logData.data.filter(item => JSON.stringify(item).includes(pDigits));
    }
    results.smsLogs = { status: smsLogsRes.status, data: logData };
  } catch (e) {
    results.smsLogs = { error: e.message };
  }

  // 4. Query template details
  if (templateId) {
    try {
      const tmplRes = await axios.get(
        `https://control.msg91.com/api/v5/sms/getTemplateVersions?template_id=${templateId}`,
        { headers, timeout: 5000, validateStatus: () => true }
      );
      results.templateDetails = { status: tmplRes.status, data: tmplRes.data };
    } catch (e) {
      results.templateDetails = { error: e.message };
    }
  }

  return results;
}

module.exports = {
  sendOtp,
  sendOtpDirect,
  sendOtpViaFlow,
  getMsg91Diagnostics,
  sendSlotConfirmationSms,
  sendBulkReminderSms,
  sendReminderSms,
  sendBulkMeetLinkSms,
  sendMeetLinkSms,
  sendBulkReminder30MinSms,
  sendReminder30MinSms,
  sendIitTeluguFlowSms,
};

