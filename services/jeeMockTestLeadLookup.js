const mongoose = require('mongoose');
const MockTestLead = require('../models/MockTestLead');
const JeeMainMockTestLead = require('../models/JeeMainMockTestLead');
const { asJeeMockTestWhatsAppLead } = require('../utils/jeeMockTestWhatsApp');

async function findById(id) {
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
  const mockLead = await MockTestLead.findById(id).lean();
  if (mockLead) return asJeeMockTestWhatsAppLead(mockLead);
  const homepageLead = await JeeMainMockTestLead.findById(id).lean();
  if (homepageLead) return asJeeMockTestWhatsAppLead(homepageLead);
  return null;
}

/**
 * Completed registration for a WhatsApp retry or manual resend.
 * Checks the /mock-test lead first, then the homepage JEE mock-test lead.
 */
async function loadJeeMockTestWhatsAppLead({ id, phone } = {}) {
  const byId = await findById(id);
  if (byId) return byId;
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!digits) return null;

  const mockLead = await MockTestLead.findOne({
    formCompleted: true,
    $or: [{ whatsappNumber: digits }, { contactNumber: digits }],
  })
    .sort({ submittedAt: -1 })
    .lean();
  if (mockLead) return asJeeMockTestWhatsAppLead(mockLead);

  const homepageLead = await JeeMainMockTestLead.findOne({
    formCompleted: true,
    $or: [{ whatsappNumber: digits }, { mobileNumber: digits }],
  })
    .sort({ submittedAt: -1 })
    .lean();
  return homepageLead ? asJeeMockTestWhatsAppLead(homepageLead) : null;
}

module.exports = {
  loadJeeMockTestWhatsAppLead,
};
