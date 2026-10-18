const Admin = require('../models/Admin');
const { ADMIN_SECTION_KEYS: ALLOWED_SECTION_KEYS } = require('../constants/adminSectionKeys');
const { auditCrmPermissionChange, crmAccessChanged } = require('../services/crm/permissionAudit');
const { commitWithAudit } = require('../utils/crmMutation');
const { CrmError } = require('../utils/crmError');

function permissionErrorResponse(res, error, fallbackMessage) {
  if (error instanceof CrmError && error.code === 'transaction_required') {
    return res.status(error.status).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
  return res.status(500).json({ success: false, message: fallbackMessage });
}

function toAdminDTO(admin) {
  return {
    id: admin._id,
    username: admin.username,
    name: admin.name || '',
    isSuperAdmin: !!admin.isSuperAdmin,
    sectionAccess: Array.isArray(admin.sectionAccess) ? admin.sectionAccess : [],
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
  };
}

function normalizeSectionAccessList(sectionAccess) {
  if (!Array.isArray(sectionAccess)) return [];
  return sectionAccess.filter((k) => typeof k === 'string' && ALLOWED_SECTION_KEYS.includes(k));
}

/**
 * GET /admin/admins — list all admins (super admin only). No passwords.
 */
exports.listAdmins = async (req, res) => {
  try {
    const admins = await Admin.find({}).sort({ createdAt: 1 }).lean().select('-password');
    return res.status(200).json({
      success: true,
      data: admins.map((a) => toAdminDTO(a)),
    });
  } catch (error) {
    console.error('[listAdmins] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * POST /admin/admins — create admin (super admin only).
 * Body: { username, password, name?, isSuperAdmin?, sectionAccess? }
 */
exports.createAdmin = async (req, res) => {
  try {
    const { username, password, name, isSuperAdmin, sectionAccess } = req.body || {};
    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ success: false, message: 'username is required' });
    }
    const trimmedPassword = typeof password === 'string' ? password.trim() : '';
    if (!password || typeof password !== 'string' || trimmedPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'password is required (min 6 characters)' });
    }
    const normalizedUsername = username.trim().toLowerCase();
    const existing = await Admin.findOne({ username: normalizedUsername });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Username already exists' });
    }
    const sectionList = normalizeSectionAccessList(sectionAccess);
    const makeSuperAdmin = !!isSuperAdmin;
    if (!makeSuperAdmin && sectionList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Select at least one section for a non–super admin.',
      });
    }
    const beforeAdmin = { isSuperAdmin: false, sectionAccess: [] };
    const afterDraft = {
      isSuperAdmin: makeSuperAdmin,
      sectionAccess: makeSuperAdmin ? [] : sectionList,
    };
    const adminFields = {
      username: normalizedUsername,
      password: trimmedPassword,
      name: typeof name === 'string' ? name.trim().slice(0, 100) : '',
      isSuperAdmin: makeSuperAdmin,
      sectionAccess: makeSuperAdmin ? [] : sectionList,
    };
    if (!crmAccessChanged(beforeAdmin, afterDraft)) {
      const admin = await Admin.create(adminFields);
      console.log('[createAdmin] Admin created:', normalizedUsername);
      return res.status(201).json({
        success: true,
        data: toAdminDTO(admin),
      });
    }
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        const created = await Admin.create([adminFields], { session });
        return created[0];
      },
      audit: (session, admin) => auditCrmPermissionChange({
        actorAdminId: req.admin._id,
        targetAdminId: admin._id,
        beforeAdmin,
        afterAdmin: admin,
        req,
        session,
      }),
    });
    console.log('[createAdmin] Admin created:', normalizedUsername);
    return res.status(201).json({
      success: true,
      data: toAdminDTO(payload),
    });
  } catch (error) {
    if (error instanceof CrmError && error.code === 'transaction_required') {
      return permissionErrorResponse(res, error);
    }
    console.error('[createAdmin] Error:', error && error.message ? error.message : 'error');
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Username already exists' });
    }
    if (crmAccessChanged(
      { isSuperAdmin: false, sectionAccess: [] },
      {
        isSuperAdmin: !!(req.body && req.body.isSuperAdmin),
        sectionAccess: normalizeSectionAccessList(req.body && req.body.sectionAccess),
      }
    )) {
      return res.status(500).json({
        success: false,
        message: 'Could not record the CRM permission change. The admin was not created.',
      });
    }
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * PATCH /admin/admins/:id — update admin role and section access (super admin only).
 * Body: { name?, isSuperAdmin?, sectionAccess? }
 */
exports.updateAdmin = async (req, res) => {
  let crmPermissionWrite = false;
  try {
    const { id } = req.params;
    const { name, isSuperAdmin, sectionAccess } = req.body || {};
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: 'Admin not found.' });
    }
    const admin = await Admin.findById(id);
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Admin not found.' });
    }
    const currentAdminId = req.admin._id.toString();
    const isSelf = currentAdminId === id;
    const previous = {
      name: admin.name,
      isSuperAdmin: admin.isSuperAdmin === true,
      sectionAccess: Array.isArray(admin.sectionAccess) ? [...admin.sectionAccess] : [],
    };

    if (typeof name === 'string') {
      admin.name = name.trim().slice(0, 100);
    }

    if (typeof isSuperAdmin === 'boolean') {
      if (isSelf && admin.isSuperAdmin && !isSuperAdmin) {
        return res.status(403).json({
          success: false,
          message: 'You cannot remove your own super admin role.',
        });
      }
      admin.isSuperAdmin = isSuperAdmin;
    }

    if (admin.isSuperAdmin) {
      admin.sectionAccess = [];
    } else if (sectionAccess !== undefined) {
      admin.sectionAccess = normalizeSectionAccessList(sectionAccess);
    }

    if (!admin.isSuperAdmin) {
      const access = Array.isArray(admin.sectionAccess) ? admin.sectionAccess : [];
      if (access.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Select at least one section for a non–super admin.',
        });
      }
    }

    if (!crmAccessChanged(previous, admin)) {
      await admin.save();
      return res.status(200).json({
        success: true,
        data: toAdminDTO(admin),
      });
    }

    crmPermissionWrite = true;
    const { payload } = await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        await admin.save({ session });
        return admin;
      },
      audit: (session, saved) => auditCrmPermissionChange({
        actorAdminId: req.admin._id,
        targetAdminId: saved._id,
        beforeAdmin: previous,
        afterAdmin: saved,
        req,
        session,
      }),
    });
    return res.status(200).json({
      success: true,
      data: toAdminDTO(payload),
    });
  } catch (error) {
    if (error instanceof CrmError && error.code === 'transaction_required') {
      return permissionErrorResponse(res, error);
    }
    console.error('[updateAdmin] Error:', error && error.message ? error.message : 'error');
    if (crmPermissionWrite) {
      return res.status(500).json({
        success: false,
        message: 'Could not record the CRM permission change. No permission was changed.',
      });
    }
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * DELETE /admin/admins/:id — remove admin (super admin only). Cannot delete self.
 * Removing an admin who can use Consultancy CRM writes a revocation audit in the same transaction.
 */
exports.deleteAdmin = async (req, res) => {
  let crmPermissionWrite = false;
  try {
    const { id } = req.params;
    const currentAdminId = req.admin._id.toString();
    const targetId = id;
    if (currentAdminId === targetId) {
      return res.status(403).json({ success: false, message: 'You cannot remove your own account.' });
    }
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(targetId)) {
      return res.status(404).json({ success: false, message: 'Admin not found.' });
    }
    const admin = await Admin.findById(targetId);
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Admin not found.' });
    }
    const beforeAdmin = {
      isSuperAdmin: admin.isSuperAdmin === true,
      sectionAccess: Array.isArray(admin.sectionAccess) ? [...admin.sectionAccess] : [],
    };
    const afterAdmin = { isSuperAdmin: false, sectionAccess: [] };
    if (!crmAccessChanged(beforeAdmin, afterAdmin)) {
      const removed = await Admin.deleteOne({ _id: admin._id });
      if (!removed.deletedCount) {
        return res.status(404).json({ success: false, message: 'Admin not found.' });
      }
      return res.status(200).json({ success: true, message: 'Admin removed.' });
    }

    crmPermissionWrite = true;
    await commitWithAudit({
      requireTransaction: true,
      mutate: async (session) => {
        const removed = await Admin.deleteOne({ _id: admin._id }).session(session);
        if (!removed.deletedCount) {
          const missing = new Error('Admin not found.');
          missing.code = 'admin_not_found';
          throw missing;
        }
        return admin;
      },
      audit: (session) => auditCrmPermissionChange({
        actorAdminId: req.admin._id,
        targetAdminId: admin._id,
        beforeAdmin,
        afterAdmin,
        req,
        session,
        action: 'crm_permission.revoked',
      }),
    });
    return res.status(200).json({ success: true, message: 'Admin removed.' });
  } catch (error) {
    if (error instanceof CrmError && error.code === 'transaction_required') {
      return permissionErrorResponse(res, error);
    }
    if (error && error.code === 'admin_not_found') {
      return res.status(404).json({ success: false, message: 'Admin not found.' });
    }
    console.error('[deleteAdmin] Error:', error && error.message ? error.message : 'error');
    if (crmPermissionWrite) {
      return res.status(500).json({
        success: false,
        message: 'Could not record the CRM permission change. The admin was not removed.',
      });
    }
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * PATCH /admin/admins/:id/password — reset another admin's password (super admin only).
 * Body: { newPassword }
 */
exports.resetAdminPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body || {};
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'newPassword is required (min 6 characters)' });
    }
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ success: false, message: 'Admin not found.' });
    }
    const admin = await Admin.findById(id);
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Admin not found.' });
    }
    admin.password = newPassword.trim();
    await admin.save();
    return res.status(200).json({ success: true, message: 'Password updated.' });
  } catch (error) {
    console.error('[resetAdminPassword] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};

/**
 * PATCH /admin/me/password — change own password (any admin).
 * Body: { currentPassword, newPassword }
 */
exports.changeMyPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || typeof currentPassword !== 'string') {
      return res.status(400).json({ success: false, message: 'Current password is required.' });
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }
    const admin = req.admin;
    const match = await admin.comparePassword(currentPassword);
    if (!match) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }
    admin.password = newPassword.trim();
    await admin.save();
    return res.status(200).json({ success: true, message: 'Password changed.' });
  } catch (error) {
    console.error('[changeMyPassword] Error:', error);
    return res.status(500).json({ success: false, message: 'Something went wrong.' });
  }
};
