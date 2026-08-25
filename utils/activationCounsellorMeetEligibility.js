const TrainingFeedback = require('../models/TrainingFeedback');
const CertifiedCounsellor2627 = require('../models/CertifiedCounsellor2627');
const otpRepository = require('./otpRepository');
const { isPrivilegedPhone } = require('./privilegedAccess');

/**
 * `/activationcounsellorsgmeet` gate: phone must exist on activation
 * (26-27 certified list or 25-26 TrainingFeedback) as mobile or WhatsApp.
 *
 * @param {string} rawPhone
 * @returns {Promise<{ status: 'allowed' | 'not_eligible', message: string, phone?: string }>}
 */
async function getActivationCounsellorMeetEligibility(rawPhone) {
  const phone = otpRepository.normalize(rawPhone);
  if (!phone || phone.length !== 10) {
    return {
      status: 'not_eligible',
      message: 'Valid 10-digit mobile number is required.',
    };
  }

  if (isPrivilegedPhone(phone)) {
    return {
      status: 'allowed',
      message: 'Eligible to join the activation counsellor meet.',
      phone,
    };
  }

  const phoneMatch = { $or: [{ mobileNumber: phone }, { whatsappNumber: phone }] };
  const exists =
    !!(await CertifiedCounsellor2627.exists(phoneMatch)) ||
    !!(await TrainingFeedback.exists(phoneMatch));

  if (!exists) {
    return {
      status: 'not_eligible',
      message:
        'We could not find an activation form submission for this number. Please complete the activation form first, then try again.',
      phone,
    };
  }

  return {
    status: 'allowed',
    message: 'Eligible to join the activation counsellor meet.',
    phone,
  };
}

module.exports = {
  getActivationCounsellorMeetEligibility,
};
