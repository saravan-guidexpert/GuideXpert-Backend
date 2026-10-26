'use strict';

/**
 * Requires an admin section key. Super Admin bypass is explicit.
 * Must run after requireAdmin so req.admin is loaded from the database.
 * Frontend navigation visibility is not consulted.
 */
function requireAdminSection(sectionKey, message) {
  if (!sectionKey || typeof sectionKey !== 'string') {
    throw new Error('requireAdminSection requires a section key');
  }
  const deniedMessage = message || 'You do not have access to this section.';

  return function adminSectionGate(req, res, next) {
    if (!req.admin) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (req.admin.isSuperAdmin === true) {
      return next();
    }
    const access = Array.isArray(req.admin.sectionAccess) ? req.admin.sectionAccess : [];
    if (!access.includes(sectionKey)) {
      return res.status(403).json({
        success: false,
        message: deniedMessage,
        code: 'section_forbidden',
      });
    }
    return next();
  };
}

module.exports = requireAdminSection;
