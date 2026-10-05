const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const gupshupLocalEnv = path.join(__dirname, '.env.gupshup.local');
if (fs.existsSync(gupshupLocalEnv)) {
  require('dotenv').config({ path: gupshupLocalEnv, override: true });
}
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const formRoutes = require('./routes/formRoutes');
const assessmentRoutes = require('./routes/assessmentRoutes');
const assessment2Routes = require('./routes/assessment2Routes');
const assessment3Routes = require('./routes/assessment3Routes');
const assessment4Routes = require('./routes/assessment4Routes');
const assessment5Routes = require('./routes/assessment5Routes');
const adminRoutes = require('./routes/adminRoutes');
const whatsappOpsAdminRoutes = require('./routes/whatsappOpsAdminRoutes');
const leadInsightsRoutes = require('./routes/leadInsightsRoutes');
const analyticsExecutiveRoutes = require('./routes/analyticsExecutiveRoutes');
const influencerRoutes = require('./routes/influencerRoutes');
const meetingRoutes = require('./routes/meetingRoutes');
const proFormRoutes = require('./routes/proFormRoutes');
const iitMeetRoutes = require('./routes/iitMeetRoutes');
const iitMeetHindiRoutes = require('./routes/iitMeetHindiRoutes');
const iitFirstFormRoutes = require('./routes/iitFirstFormRoutes');
const iitSecondFormRoutes = require('./routes/iitSecondFormRoutes');
const collegeDostFormRoutes = require('./routes/collegeDostFormRoutes');
const collegeDostMeetRoutes = require('./routes/collegeDostMeetRoutes');
const trainingRoutes = require('./routes/trainingRoutes');
const feedbackRoutes = require('./routes/feedbackRoutes');
const trainingFormRoutes = require('./routes/trainingFormRoutes');
const iitainSessionFeedbackRoutes = require('./routes/iitainSessionFeedbackRoutes');
const oneOnOneCounselingRoutes = require('./routes/oneOnOneCounselingRoutes');
const jeeSessionRoutes = require('./routes/jeeSessionRoutes');
const mockTestRoutes = require('./routes/mockTestRoutes');
const guidanceBookingRoutes = require('./routes/guidanceBookingRoutes');
const oneOnOneCounselorRoutes = require('./routes/oneOnOneCounselorRoutes');
const referralRoutes = require('./routes/referralRoutes');
const cronRoutes = require('./routes/cronRoutes');
const counsellorAuthRoutes = require('./routes/counsellorAuthRoutes');
const counsellorWebinarProgressRoutes = require('./routes/counsellorWebinarProgressRoutes');
const posterRoutes = require('./routes/posterRoutes');
const studentRoutes = require('./routes/studentRoutes');
const collegePredictorRoutes = require('./routes/collegePredictorRoutes');
const collegePredictorPublicRoutes = require('./routes/collegePredictorPublicRoutes');
const webChatRoutes = require('./routes/webChatRoutes');
const rankPredictorPublicRoutes = require('./routes/rankPredictorPublicRoutes');
const counsellorAssessmentRoutes = require('./routes/counsellorAssessmentRoutes');
const assessmentCareerDnaRoutes = require('./routes/assessmentCareerDnaRoutes');
const assessmentCourseFitRoutes = require('./routes/assessmentCourseFitRoutes');
const announcementRoutes = require('./routes/announcementRoutes');
const certificateRoutes = require('./routes/certificateRoutes');
const webinarAssessmentRoutes = require('./routes/webinarAssessmentRoutes');
const webinarProgressRoutes = require('./routes/webinarProgressRoutes');
const blogRoutes = require('./routes/blogRoutes');
const posterTemplatePublicRoutes = require('./routes/posterTemplatePublicRoutes');
const osviRoutes = require('./routes/osviRoutes');
const counsellorSupportRoutes = require('./routes/counsellorSupportRoutes');
const gupshupWebhookRoutes = require('./routes/gupshupWebhookRoutes');
const whatsappChatAdminRoutes = require('./routes/whatsappChatAdminRoutes');
const aiCallsAdminRoutes = require('./routes/aiCallsAdminRoutes');
const whatsappChatBdaRoutes = require('./routes/whatsappChatBdaRoutes');
const { configStatus: counsellorConfigStatus } = require('./controllers/counsellorAuthController');
const { getPosterDownloads, getPosterDownloadStats } = require('./controllers/posterDownloadController');
const { getCollegeComparisons } = require('./controllers/collegeComparisonAdminController');
const { checkPosterEligibility, trackPosterDownload } = require('./controllers/posterController');
const requireAdmin = require('./middleware/requireAdmin');
const {
  getWhatsAppConfigStatus,
  logWhatsAppConfigWarnings,
} = require('./utils/whatsappConfigStatus');
const app = express();

// OTP (MSG91): required in production only; in dev allow startup without them
const requiredOtpEnv = ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID', 'OTP_SECRET'];
const missing = requiredOtpEnv.filter((k) => !process.env[k] || !String(process.env[k]).trim());
if (missing.length > 0) {
  // Never crash the whole API for OTP-only env gaps.
  // Keep non-OTP routes (blogs, health, etc.) available.
  console.warn(
    '[env] OTP not fully configured:',
    missing.join(', '),
    '— OTP/SMS routes may fail until env vars are set.'
  );
}
const envStatus = {
  MSG91_AUTH_KEY: process.env.MSG91_AUTH_KEY ? `set (${process.env.MSG91_AUTH_KEY.length} chars)` : 'missing',
  MSG91_TEMPLATE_ID: process.env.MSG91_TEMPLATE_ID ? 'set' : 'missing',
  OTP_SECRET: process.env.OTP_SECRET ? 'set' : 'missing',
  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET ? 'set' : 'missing',
};
console.log('[env] OTP (MSG91) config:', envStatus);
if (!process.env.ADMIN_JWT_SECRET) {
  console.warn('[env] ADMIN_JWT_SECRET is not set — admin login and /api/admin/leads will return 500. Add it to .env');
}
if (!process.env.COUNSELLOR_JWT_SECRET) {
  console.warn('[env] COUNSELLOR_JWT_SECRET is not set — counsellor login and /api/counsellor/students will return 500. Add it to .env');
}
if (!process.env.WEBINAR_JWT_SECRET && !process.env.COUNSELLOR_JWT_SECRET) {
  console.warn('[env] WEBINAR_JWT_SECRET and COUNSELLOR_JWT_SECRET are both missing — webinar login will fail. Set at least one in .env / Vercel env vars.');
}
logWhatsAppConfigWarnings();

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://www.guidexpert.co.in',
  'https://guidexpert.co.in',
  'http://www.guidexpert.co.in',
  'http://guidexpert.co.in',
  'https://guide-xpert-frontend.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
].filter(Boolean);
if (allowedOrigins.length === 0) allowedOrigins.push('https://guidexpert.co.in');
// Allow any Vercel preview/production frontend (*.vercel.app)
const vercelOriginRegex = /^https:\/\/[a-z0-9-]+(-[a-z0-9-]+)*\.vercel\.app$/i;
// Any localhost / 127.0.0.1 port (Vite may use 5173, 5174, etc.)
const localhostDevOriginRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
// Production/staging on guidexpert.co.in (www or subdomains)
const guidexpertOriginRegex = /^https?:\/\/([a-z0-9-]+\.)*guidexpert\.co\.in$/i;

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  return (
    allowedOrigins.includes(origin) ||
    vercelOriginRegex.test(origin) ||
    localhostDevOriginRegex.test(origin) ||
    guidexpertOriginRegex.test(origin)
  );
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) {
      return callback(null, origin || allowedOrigins[0]);
    }
    console.warn('[cors] Blocked origin:', origin);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
// Poster templates: large SVG + JSON overhead; keep above MAX_SVG_CHARS in posterTemplateController (~2MB markup alone)
function logAdminPosterJsonBody(req, res, buf) {
  try {
    if (req.method !== 'POST') return;
    const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
    if (!/\/api\/admin\/posters\/?$/.test(pathOnly)) return;
    const hasKey = /"svgTemplate"\s*:|"svg_template"\s*:/.test(buf.toString('utf8', 0, Math.min(buf.length, 65536)));
    console.log('[json body] POST /api/admin/posters', 'bytes=', buf.length, 'svg key in first 64k=', hasKey);
  } catch {
    /* ignore */
  }
}
app.use(express.json({ limit: '15mb', verify: logAdminPosterJsonBody }));
app.use(express.urlencoded({ extended: true }));

// Ensure MongoDB is connected before handling requests (Vercel serverless cold start)
let dbConnectPromise = null;

function resetDbConnectPromise() {
  dbConnectPromise = null;
}

mongoose.connection.on('disconnected', () => {
  console.warn('[ensureDB] MongoDB disconnected — will reconnect on next request');
  resetDbConnectPromise();
});

mongoose.connection.on('error', (err) => {
  console.error('[ensureDB] MongoDB connection error:', err?.message || err);
  resetDbConnectPromise();
});

async function ensureDbConnected() {
  if (mongoose.connection.readyState === 1) return;
  if (!dbConnectPromise) {
    dbConnectPromise = connectDB().catch((err) => {
      resetDbConnectPromise();
      throw err;
    });
  }
  await dbConnectPromise;
}

function shouldBypassDbGate(req) {
  if (req.path === '/api/health') return true;
  if (req.method !== 'GET') return false;
  return /^\/(?:api\/)?blogs(?:\/[^/]+)?\/?$/.test(req.path);
}

app.use(async (req, res, next) => {
  if (shouldBypassDbGate(req)) return next();
  try {
    await ensureDbConnected();
    next();
  } catch (err) {
    console.error('[ensureDB]', err?.message || err);
    next(err);
  }
});

// Register specific /api routes before any broad `app.use('/api', router)` mounts.
app.get('/api/health', async (req, res) => {
  const whatsapp = getWhatsAppConfigStatus();
  res.json({
    status: 'ok',
    message: 'GuideXpert API is running',
    features: { posterDownloadAdmin: true },
    whatsapp,
    chatbot: { mode: 'llm_only_admin_prompt' },
  });
});
app.get('/api/admin/poster-downloads/stats', requireAdmin, getPosterDownloadStats);
app.get('/api/admin/poster-downloads', requireAdmin, getPosterDownloads);
app.get('/api/admin/college-comparisons', requireAdmin, getCollegeComparisons);
// Public poster endpoints — registered before counsellor routers whose
// router.use(requireCounsellor) would otherwise block unauthenticated requests.
app.post('/api/counsellor/poster-eligibility', checkPosterEligibility);
app.post('/api/counsellor/poster-downloads/track', trackPosterDownload);

// Public college predictor (no auth) — mount before counsellor routes
app.use('/api/college-predictor', collegePredictorPublicRoutes);
app.use('/api/web-chat', webChatRoutes);
// Public rank predictor (strict dataset lookup)
app.use('/api/rank-predictor', rankPredictorPublicRoutes);
// Mount more specific paths first so /api/counsellor/students is never handled by generic /api
app.use('/api/counsellor/students', studentRoutes);
app.use('/api/counsellor/announcements', announcementRoutes);
app.use('/api/counsellor/college-predictor', collegePredictorRoutes);
app.get('/api/counsellor/config-status', counsellorConfigStatus);
app.use('/api/counsellor', counsellorAssessmentRoutes);
app.use('/api/counsellor', posterRoutes);
app.use('/api/counsellor', counsellorAuthRoutes);
app.use('/api/counsellor', counsellorWebinarProgressRoutes);
app.use('/api', formRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/assessment-2', assessment2Routes);
app.use('/api/assessment-3', assessment3Routes);
app.use('/api/assessment-4', assessment4Routes);
app.use('/api/assessment-5', assessment5Routes);
app.use('/api/assessment-career-dna', assessmentCareerDnaRoutes);
app.use('/api/assessment-course-fit', assessmentCourseFitRoutes);
app.use('/api', influencerRoutes);
// Blogs API (public read, admin-protected writes)
app.use('/blogs', blogRoutes);
// Backward compatible alias (can be removed once all clients migrate)
app.use('/api/blogs', blogRoutes);
// Compatibility alias for misconfigured clients sending /api/api/blogs
app.use('/api/api/blogs', blogRoutes);
app.use('/api/posters', posterTemplatePublicRoutes);
// WhatsApp Messaging Ops console — explicit mount before generic /api/admin (same middleware stack elsewhere).
app.use('/api/admin/whatsapp-ops', requireAdmin, whatsappOpsAdminRoutes);
app.use('/api/admin/whatsapp-chat', requireAdmin, whatsappChatAdminRoutes);
app.use('/api/admin/ai-calls', requireAdmin, aiCallsAdminRoutes);
app.use('/api/admin/lead-insights', requireAdmin, leadInsightsRoutes);
app.use('/api/admin/analytics', requireAdmin, analyticsExecutiveRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/resources', require('./routes/resourceRoutes'));
app.get('/api/student-workspace-updates', require('./controllers/studentWorkspaceUpdateController').publicList);
app.get('/api/student-live-activity', require('./controllers/studentLiveActivityController').publicLiveFeed);
app.get('/api/student-testimonials', require('./controllers/studentTestimonialController').publicList);
app.use('/api/bda', require('./routes/bdaRoutes'));
app.use('/api/bda/whatsapp-chat', whatsappChatBdaRoutes);
app.use('/api/meeting', meetingRoutes);
app.use('/api/pro-form', proFormRoutes);
app.use('/api/iit-meet', iitMeetRoutes);
app.use('/api/iit-meet-hindi', iitMeetHindiRoutes);
app.use('/api/iit-first-form', iitFirstFormRoutes);
app.use('/api/iit-second-form', iitSecondFormRoutes);
app.use('/api/college-dost-form', collegeDostFormRoutes);
app.use('/api/college-dost-meet', collegeDostMeetRoutes);
app.use('/api/training', trainingRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/training-form', trainingFormRoutes);
app.use('/api/iitain-session-feedback', iitainSessionFeedbackRoutes);
app.use('/api/one-on-one-counseling', oneOnOneCounselingRoutes);
app.use('/api/jee-sessions', jeeSessionRoutes);
app.use('/api/mock-test', mockTestRoutes);
app.use('/api/guidance-booking', guidanceBookingRoutes);
app.use('/api/one-on-one-counselor', oneOnOneCounselorRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/certificate', certificateRoutes);
app.use('/api/webinar-assessment', webinarAssessmentRoutes);
app.use('/api/webinar-progress', webinarProgressRoutes);
app.use('/api/osvi', osviRoutes);
app.use('/api/counsellor-support', counsellorSupportRoutes);
// Gupshup app callback URL (production): POST https://<API_HOST>/webhook/gupshup — configure in Gupshup console; no admin auth.
app.use('/webhook/gupshup', gupshupWebhookRoutes);
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[Server error]', err);
  const message = process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong.';
  res.status(500).json({ success: false, message });
});

const PORT = process.env.PORT || 5000;

// Start server only after MongoDB connection is established (local dev only)
const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`MongoDB connection established. Server ready to accept requests.`);

      if (String(process.env.DEV_IIT_CRON_LOOP || '').trim() === '1') {
        const secret = process.env.CRON_SECRET || process.env.GUIDEXPERT_CRON_SECRET;
        const cronBase = `http://127.0.0.1:${PORT}`;
        const tickMs = Math.max(30_000, parseInt(process.env.DEV_IIT_CRON_INTERVAL_MS || '60000', 10) || 60_000);
        console.log(`[dev] IIT reminder cron loop every ${tickMs}ms → ${cronBase}/api/cron/send-iit-reminders`);
        setInterval(() => {
          if (!secret) return;
          fetch(`${cronBase}/api/cron/send-iit-reminders?key=${encodeURIComponent(secret)}`).catch((err) => {
            console.warn('[dev] IIT cron tick failed:', err.message);
          });
        }, tickMs);
      }

      if (String(process.env.DEV_GUIDANCE_REMINDER_CRON_LOOP || '').trim() === '1') {
        const secret = process.env.CRON_SECRET || process.env.GUIDEXPERT_CRON_SECRET;
        const cronBase = `http://127.0.0.1:${PORT}`;
        const tickMs = Math.max(
          30_000,
          parseInt(process.env.DEV_GUIDANCE_REMINDER_CRON_INTERVAL_MS || '60000', 10) || 60_000
        );
        console.log(
          `[dev] Guidance reminder cron loop every ${tickMs}ms → ${cronBase}/api/cron/send-guidance-reminders`
        );
        setInterval(() => {
          if (!secret) return;
          fetch(`${cronBase}/api/cron/send-guidance-reminders?key=${encodeURIComponent(secret)}`).catch((err) => {
            console.warn('[dev] Guidance reminder cron tick failed:', err.message);
          });
        }, tickMs);
      }

      if (String(process.env.DEV_IIT_TELUGU_SMS_CRON_LOOP || '').trim() === '1') {
        const secret = process.env.CRON_SECRET || process.env.GUIDEXPERT_CRON_SECRET;
        const cronBase = `http://127.0.0.1:${PORT}`;
        const tickMs = Math.max(
          30_000,
          parseInt(process.env.DEV_IIT_TELUGU_SMS_CRON_INTERVAL_MS || '60000', 10) || 60_000
        );
        console.log(
          `[dev] IIT Telugu SMS cron loop every ${tickMs}ms → ${cronBase}/api/cron/send-iit-telugu-sms`
        );
        setInterval(() => {
          if (!secret) return;
          fetch(`${cronBase}/api/cron/send-iit-telugu-sms?key=${encodeURIComponent(secret)}`).catch(
            (err) => {
              console.warn('[dev] IIT Telugu SMS cron tick failed:', err.message);
            }
          );
        }, tickMs);
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Start HTTP listener only when this file is executed directly (local/dev).
// In serverless runtimes (e.g., Vercel), the platform imports this module.
if (require.main === module) {
  startServer();
}

module.exports = app;
