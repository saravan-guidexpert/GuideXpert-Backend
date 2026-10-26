'use strict';

const { CrmError } = require('./crmError');

/**
 * Normalize an Indian mobile number to 10 digits.
 * Accepts XXXXXXXXXX, 91XXXXXXXXXX, and +91XXXXXXXXXX, with spaces, hyphens, or parentheses.
 * Rejects other country codes, leading trunk zeros, and any ambiguous length.
 */
function normalizeIndianMobile(input) {
  if (input == null || (typeof input !== 'string' && typeof input !== 'number')) {
    throw new CrmError(400, 'A mobile number is required.', 'invalid_phone');
  }
  const raw = String(input).trim();
  if (!raw) {
    throw new CrmError(400, 'A mobile number is required.', 'invalid_phone');
  }
  if (!/^[+\d][\d\s()-]*$/.test(raw)) {
    throw new CrmError(400, 'Mobile number contains invalid characters.', 'invalid_phone');
  }
  const compact = raw.replace(/[\s()-]/g, '');
  if (!/^\+?\d+$/.test(compact)) {
    throw new CrmError(400, 'Mobile number format is not valid.', 'invalid_phone');
  }

  let digits = compact;
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+91')) {
      throw new CrmError(400, 'Only Indian mobile numbers (+91) are accepted.', 'invalid_phone');
    }
    digits = digits.slice(1);
  }

  let national;
  if (digits.length === 10) {
    national = digits;
  } else if (digits.length === 12 && digits.startsWith('91')) {
    national = digits.slice(2);
  } else {
    throw new CrmError(
      400,
      'Enter a 10-digit Indian mobile number, or the same number prefixed with 91 or +91.',
      'invalid_phone'
    );
  }

  if (!/^[6-9]\d{9}$/.test(national)) {
    throw new CrmError(
      400,
      'Indian mobile numbers must be 10 digits and start with 6, 7, 8, or 9.',
      'invalid_phone'
    );
  }
  return national;
}

module.exports = { normalizeIndianMobile };
