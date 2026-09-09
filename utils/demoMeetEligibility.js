const FormSubmission = require('../models/FormSubmission');
const otpRepository = require('./otpRepository');
const { formatIst } = require('./demoMeetLiveWindows');

const FIVE_MIN_MS = 5 * 60 * 1000;
const SLOT_DURATION_MS = 60 * 60 * 1000;

/**
 * Demo `/meet` gate: anyone who provides a valid 10-digit phone number is allowed to enter.
 * Booking requirements and live IST windows are not enforced.
 *
 * @param {string} rawPhone
 * @param {Date} [_now] unused; kept for API stability / tests
 * @returns {Promise<{
 *   status: 'allowed'|'no_booking',
 *   message: string,
 *   phone?: string,
 *   selectedSlot?: string|null,
 *   originalBookingSlotStart?: string|null,
 *   originalBookingSlotStartLabel?: string,
 *   slotStart?: string|null,
 *   joinOpensAt?: string|null,
 *   slotEnd?: string|null,
 *   slotStartLabel?: string,
 *   joinOpensAtLabel?: string,
 *   slotEndLabel?: string
 * }>}
 */
async function getDemoMeetEligibility(rawPhone, _now = new Date()) {
  const phone = otpRepository.normalize(rawPhone);
  if (!phone || phone.length !== 10) {
    return {
      status: 'no_booking',
      message: 'Valid 10-digit mobile number is required.',
    };
  }

  const doc = await FormSubmission.findOne({ phone })
    .select('step3Data isRegistered currentStep')
    .lean();

  const slotDate = doc?.step3Data?.slotDate;
  const slotStart = slotDate != null ? new Date(slotDate) : null;
  const validDate = slotStart && !Number.isNaN(slotStart.getTime());

  const bookingInfo = {
    phone,
    selectedSlot: doc?.step3Data?.selectedSlot || null,
    originalBookingSlotStart: validDate ? slotStart.toISOString() : null,
    originalBookingSlotStartLabel: validDate ? formatIst(slotStart) : '',
  };

  return {
    status: 'allowed',
    message: 'You may join the live demo now.',
    ...bookingInfo,
    slotStart: validDate ? slotStart.toISOString() : null,
    joinOpensAt: null,
    slotEnd: null,
    joinOpensAtLabel: '',
    slotEndLabel: '',
    slotStartLabel: validDate ? formatIst(slotStart) : '',
  };
}

module.exports = {
  getDemoMeetEligibility,
  FIVE_MIN_MS,
  SLOT_DURATION_MS,
};
