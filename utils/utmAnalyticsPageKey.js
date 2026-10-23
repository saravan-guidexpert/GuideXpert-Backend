const SAVED_LINKS_ONLY_PAGE_KEYS = new Set(['oneOnOneSession', 'guidanceBookingConfirmation', 'mainPage']);

/** Maps admin ?linkTarget= to IitCounsellingVisit.pageKey. */
function resolveUtmAnalyticsPageKey(query = {}) {
  const raw = query.linkTarget || query.pageKey || '';
  const s = String(raw).trim().toLowerCase().replace(/-/g, '_');
  if (s === 'oneononesession' || s === 'one_on_one_session') return 'oneOnOneSession';
  if (s === 'guidancebookingconfirmation' || s === 'guidance_booking_confirmation') {
    return 'guidanceBookingConfirmation';
  }
  if (
    s === 'mainpage' || s === 'main_page' || s === 'home'
    || s === 'jeemocktest' || s === 'jee_mock_test'
  ) return 'mainPage';
  return 'iitCounselling';
}

function isSavedLinksOnlyUtmPageKey(pageKey) {
  return SAVED_LINKS_ONLY_PAGE_KEYS.has(pageKey);
}

module.exports = { resolveUtmAnalyticsPageKey, isSavedLinksOnlyUtmPageKey };
