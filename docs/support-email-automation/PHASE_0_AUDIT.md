# GuideXpert Support Email Automation — Phase 0 Audit & Architecture Validation

**Phase:** 0 — Repository audit and architecture validation
**Date:** 2026-11-13
**Status:** Audit complete. Implementation not started.
**Audience:** Engineering, DevOps, Security, Support operations

---

## 0. Document control

| Item | Value |
|---|---|
| Repository audited | `GuideXpert-Backend` |
| Branch | `main-publish` |
| HEAD at audit time | `68d4a4541a3ef8fa3b9f65064167605f94df96e1` |
| Working tree state | Dirty before audit. Unrelated AI Answer Studio changes (`models/AnswerStudioPrompt.js`, `services/answerStudio/*`, `server.js`, tests) were already modified/untracked. None were touched. |
| Runtime observed locally | Node.js `v24.21.0` |
| Hosting | Vercel Pro (backend `gxp-new-backend.vercel.app`, per `GuideXpert-Frontend/vercel.json` rewrite) |
| Database | MongoDB Atlas through Mongoose 9 |
| Frontend | `GuideXpert-Frontend` — React 19 + Vite SPA with an existing `/admin` area |
| Change made by this phase | **One file only:** this document. No application code, models, routes, crons, `package.json`, or Vercel config were changed. Nothing was installed, committed, or pushed. |

**Documentation location:** the repository convention is `docs/*.md` for cross-cutting reports and `docs/<feature>/PHASE-*.md` for feature phases (for example `docs/answer-studio/PHASE-1-IMPLEMENTATION.md`). `docs/support-email-automation/PHASE_0_AUDIT.md` follows that convention, so no alternative location is proposed.

**Evidence labels used throughout:**

- **VERIFIED** — directly observed in the working tree or in the cited official vendor documentation.
- **ESTIMATE** — derived from arithmetic or an explicit assumption. Must be measured during later phases.
- **RECOMMENDATION** — proposed design or control. Not implemented.
- **UNRESOLVED** — requires a business, security, or platform-owner decision.

> No credentials, tokens, service-account JSON, private keys, or environment values were read, copied, or recorded in this document. The Entra client and tenant IDs were supplied in the Phase 0 brief; they are non-secret identifiers and are recorded only to make the readiness checklist unambiguous.

---

## 1. Executive summary

### 1.1 What already exists

The backend is a mature, single-deployment Express 5 monolith backed by MongoDB/Mongoose. It already contains the exact primitives a support-email system needs, just applied to WhatsApp and forms:

- A **fast webhook ingestion path** with signature verification, provider-event deduplication, a pending-work row, inline processing with a timeout, and cron replay (`controllers/gupshupWebhookController.js`, `services/chatbot/whatsappInboundService.js`).
- A **durable MongoDB work queue** with atomic claims, lease expiry, claim tokens, retry state, and crash recovery (`services/whatsappReminderJobDispatcher.js`, `models/WhatsAppReminderJob.js`).
- A **cron execution ledger** (`models/MessagingCronRun.js`) and secret-protected cron routes (`routes/cronRoutes.js`).
- A **provider-agnostic AI client** over an OpenAI-compatible API (`services/ai/llmClient.js`, `services/ai/providers/OpenAiCompatibleProvider.js`).
- A **Google Sheets service-account client** (`config/googleSheets.js`) and two append helpers (`utils/googleSheetsService.js`, `utils/sheetsService.js`).
- **Admin authentication and section-level authorization** (`middleware/requireAdmin.js`, `middleware/requireAdminSection.js`).
- **Private binary storage in MongoDB GridFS** (`services/resourceStorageService.js`) with chunked uploads for files up to 20 MB.
- A serious **index-safety guard** that forces `autoIndex` off on every remote MongoDB (`config/mongooseSafety.js`) and reviewed index scripts that refuse production.
- A **`node:test` + in-memory MongoDB replica-set** test culture with race/recovery integration suites (`test/integration/suites/*`).

### 1.2 What does not exist

**VERIFIED:** there is no Microsoft Graph, Outlook, email, mailbox, or support-ticket code anywhere in the repository. A repository-wide search for `graph.microsoft`, `msgraph`, `outlook`, `support@niatindia`, and `niatindia` returned no application code. There are no email/ticket models and no Graph environment variables. This is a greenfield module inside an existing platform.

### 1.3 Readiness scorecard

| Area | Current capability | Reuse for email | Assessment |
|---|---|---|---|
| HTTP backend | Express 5 monolith, 62 route modules, 79 controllers, 174 service files | High | **Strong** |
| Durable queue | Proven Mongo lease-claim queue for WhatsApp reminders | High (pattern), none (email) | **Strong pattern, absent module** |
| MongoDB | 128 models, connection gate, index safety, GridFS | High | **Strong** |
| AI | OpenAI-compatible client, retries/timeouts | Medium–High | **Adequate; structured-output gap** |
| Google Sheets | Service-account client, append-only helpers | Medium | **Adequate; needs an idempotent outbox** |
| Vercel | Pro, 8 cron jobs at 1-minute cadence, 60-second function cap | Medium | **Adequate with batched, resumable work** |
| Microsoft Graph | Nothing | None | **Absent; blocked on mailbox scoping** |
| Security controls | Admin JWT + section keys, log redaction helpers | Medium | **Needs email/PII hardening** |
| Observability | Console logs, structured chatbot logs, cron run ledger | Medium | **Adequate foundation; needs metrics/alerts** |
| Test foundation | `node:test`, memory replica set, crash/race suites | High | **Strong** |

### 1.4 Verdict

**Phase 0: PASS.** The repository is architecturally suitable for the support-email system. The existing WhatsApp inbound + reminder-job stack provides a proven, production-shaped blueprint for deduplication, durable queueing, lease recovery, and cron replay. No Redis, BullMQ, or separate worker is justified at the stated volume.

**Phase 1 (models and processing foundation) may start after approval.**

**Phase 2 (Microsoft Graph integration) is BLOCKED** until four prerequisites are resolved:

1. **Mailbox scoping.** The tenant-wide `Mail.Read` application grant must not remain the effective authorization. Exchange Online RBAC for Applications must restrict access strictly to `support@niatindia.com`, with zero application permissions granted in Entra ID.
2. **Application credential.** A certificate (preferred) or client secret must exist and be stored only in Vercel encrypted environment variables.
3. **Public, unauthenticated webhook reachability.** Vercel Deployment Protection (if enabled) must allow Microsoft Graph to reach `/webhook/graph`.
4. **Storage and retention decision.** Attachment volume and retention determine whether GridFS remains appropriate or whether an external object store is required.

### 1.5 Top decisions needed before Phase 1 ends

| # | Decision | Recommended option | Why now |
|---|---|---|---|
| D1 | Mailbox authorization model | Exchange Online **RBAC for Applications**, scoped to a group containing only the support mailbox, and **remove the unscoped Entra `Mail.Read` grant** | The current grant can read every mailbox in the tenant; this violates the stated business restriction |
| D2 | Attachment storage | Start with **GridFS** behind a storage abstraction; measure volume in Phase 3 and move to Vercel Blob/S3 only if Atlas cost or backup size becomes unacceptable | Avoids new infrastructure without evidence |
| D3 | Retention periods | Separate raw email, attachment, ticket, AI-run, and audit retention; legal review for India DPDP Act obligations | Drives schema fields and deletion jobs |
| D4 | AI provider/model and data policy | Confirm the production model, rate limits, structured-output support, and a zero-retention/DPA arrangement | Student PII will be sent to the model |
| D5 | OCR strategy for images | Prefer a vision-capable model if the existing provider supports it; otherwise add a local OCR dependency | Affects Phase 3 dependencies and cost |
| D6 | Sheets destination | A **new** spreadsheet/tab dedicated to support tickets; never reuse `GOOGLE_SHEET_ID` (`Formresponses`) | Prevent ticket rows polluting the forms reporting sheet |

---

## 2. Scope, method, and evidence

### 2.1 Inspected

**Entry points and configuration**
`package.json`, `server.js`, `vercel.json`, `nodemon.json`, `README.md`, `docs/` structure, `GuideXpert-Frontend/vercel.json`, `GuideXpert-Frontend/src/constants/adminSectionAccess.js`, `GuideXpert-Frontend/src/components/Admin/AdminLayout.jsx`.

**Database**
`config/db.js`, `config/mongooseSafety.js`, `utils/mongoConnectionGate.js`, `utils/mongoRetry.js`, representative models (`FormSubmission`, `WhatsAppInboundMessage`, `WhatsAppWebhookEvent`, `WhatsAppReminderJob`, `MessagingCronRun`, `AppSettings`, `AnswerStudioPrompt`, `AnswerStudioGeneration`, `ConversationRecoveryAuditLog`).

**HTTP and auth**
`middleware/requireAdmin.js`, `middleware/requireAdminSection.js`, `constants/adminSectionKeys.js`, `routes/cronRoutes.js`, `routes/gupshupWebhookRoutes.js`, `controllers/gupshupWebhookController.js`, `controllers/formController.js`, `routes/adminRoutes.js`.

**AI**
`services/ai/llmClient.js`, `services/ai/providers/OpenAiCompatibleProvider.js`, `services/ai/providers/NvidiaEmbeddingProvider.js`, `services/ai/prompts/*`, `services/chatbot/llmOnlyChatService.js`, `services/chatbot/intentClassifierService.js`, `services/answerStudio/generationService.js`, `services/answerStudio/promptResolver.js`, `services/answerStudio/promptValidation.js`.

**WhatsApp inbound and background work**
`services/chatbot/whatsappInboundService.js`, `services/whatsappReminderJobDispatcher.js`, `utils/gupshupInboundPayload.js`, `utils/cronSecret.js`, `services/chatbot/chatbotStructuredLog.js`.

**Google Sheets and storage**
`config/googleSheets.js`, `utils/googleSheetsService.js`, `utils/sheetsService.js`, `services/resourceStorageService.js`, `controllers/studentResourceController.js`.

**Tests**
`test/*.test.js` inventory, `test/integration/harness/*`, `test/integration/suites/*`, `test/crmRateLimit.test.js`, `test/gupshupInboundWaitUntil.test.js`.

### 2.2 Not inspected / not verified

- Production environment variable values, Atlas cluster tier, backup policy, and network access list.
- The Entra portal, Exchange Online configuration, and actual mailbox contents.
- Vercel project settings (Deployment Protection, function memory, region, Node runtime, custom domains).
- The production LLM base URL/model, provider rate limits, data-retention terms, and pricing.
- Microsoft 365 licence/Defender configuration for the mailbox.
- Real email volume, attachment size distribution, and peak arrival rate. The 2,000/day figure is a **requirement**, not a measurement.

### 2.3 External documentation consulted

- Microsoft Graph change notifications: subscription lifetimes and limits.
- Microsoft Graph delta query for messages.
- Exchange Online RBAC for Applications.
- Microsoft Graph throttling limits (Outlook service limits).
- Vercel function duration and cron limits.
- Google Sheets API quotas.

URLs are listed in Appendix F.

---

## 3. Existing architecture map

### 3.1 Runtime topology

```text
Browser / Admin SPA (React 19 + Vite)
        |
        |  /api/* rewrite
        v
Vercel project: gxp-new-backend.vercel.app
  one Node function built from server.js (@vercel/node, maxDuration 60s)
        |
        +--> MongoDB Atlas (Mongoose 9, cached connection, pool 10/isolate)
        +--> Google Sheets API (service account)
        +--> Gupshup WhatsApp API + inbound webhook
        +--> MSG91 SMS / OTP
        +--> OSVI calling API
        +--> OpenAI-compatible LLM endpoint (LLM_BASE_URL / LLM_MODEL)
        |
Vercel Cron (8 schedules, every minute)
        |
        +--> GET /api/cron/* (secret-protected)
```

**VERIFIED:**
- `server.js` builds and exports a single Express app; the local listener starts only when `require.main === module` (`startServer`), so Vercel imports the app.
- `GuideXpert-Frontend/vercel.json` proxies `/api/:path*` to `https://gxp-new-backend.vercel.app/api/:path*`.
- `vercel.json` uses the legacy `builds` array with `@vercel/node` and `config.maxDuration: 60`.
- Eight cron entries run every minute: `send-reminders`, `send-meetlinks`, `send-30min-reminders`, `retry-whatsapp`, `send-iit-reminders`, `send-guidance-reminders`, `send-iit-telugu-sms`, `process-chatbot-inbound`.

### 3.2 Layering and conventions

The codebase follows a consistent CommonJS layering:

```text
routes/*.js          thin Express routers; mount paths; middleware composition
controllers/*.js     request parsing, authorization context, response shaping
services/**/*.js     business logic and orchestration
models/*.js          Mongoose schemas, enums, indexes, occasional hooks
utils/*.js           stateless helpers (retry, redaction, secrets, payload parsing)
config/*.js          infrastructure clients (Mongo, Google Sheets, safety guards)
constants/*.js       shared enums and keys
```

Conventions observed:

- CommonJS (`"type": "commonjs"`), not TypeScript.
- Controllers return `{ success: true|false, ... }`; errors are JSON with safe messages.
- `async` route handlers are used directly. Express 5 forwards rejected promises to the error middleware, so no `asyncHandler` wrapper is needed.
- Most services accept plain objects and return plain objects; no dependency-injection container.
- Environment access is direct `process.env.*` at call time in the AI provider, but captured at module load in `config/googleSheets.js`.
- Tests use `node:test` and `mongodb-memory-server`; there is no CI workflow file in the backend.

### 3.3 Request lifecycle

**VERIFIED** in `server.js`:

1. `dotenv` loads `.env`, then optionally `.env.gupshup.local` with override.
2. OTP/admin/counsellor env presence is logged; the process does not crash on missing OTP keys.
3. `cors(apiCorsOptions())` is applied.
4. `express.json({ limit: '15mb' })` and `express.urlencoded()` parse bodies.
5. A global DB gate calls `connectDB()` unless the path is `/api/health` or a GET blog path (`shouldBypassDbGate`).
6. Specific routes are mounted before broad routers (for example `/api/admin/whatsapp-ops` before `/api/admin`).
7. A catch-all returns JSON 404.
8. A final error middleware logs through `logDbError`, maps transient Mongo errors to 503, and returns a safe message.
9. `POST /webhook/gupshup` is mounted without admin auth; the route performs its own webhook authentication.

**Critical implication for Graph webhooks:** the global DB gate runs before every route except `/api/health` and blog GETs. A Graph subscription validation request must answer within 10 seconds. A cold start plus Atlas connection can consume most of that budget. Phase 2 must add a narrow bypass for the validation handshake (only when `validationToken` is present), without bypassing the gate for real notifications.

### 3.4 Background and scheduled execution

There is **no continuously running worker**. Background work is one of:

- **Inline** in a webhook request with a hard timeout, then deferred to cron on timeout (`whatsappInboundService.handleInboundWebhook`, `CHATBOT_INBOUND_TIMEOUT_MS`, default 9,000 ms).
- **Cron-driven** through `routes/cronRoutes.js`, authenticated by `verifyCronSecret` and a shared secret (`GUIDEXPERT_CRON_SECRET` or `CRON_SECRET`).
- **Dev-only loops** started inside `startServer` when `DEV_*_CRON_LOOP=1`; these use `setInterval` and are not production infrastructure.

The reminder queue is the strongest precedent for email:

- `WhatsAppReminderJob` has `state`, `attempts`, `claimedAt`, `claimedBy`, `claimToken`, `claimedUntil`, `leaseExpiresAt`, `cronRunId`, `lastError`.
- `claimOneJob` performs one atomic `findOneAndUpdate` with a lease-free `$or` filter and a sort, then returns a claimed document.
- `releaseJobClaim` and `transitionToDispatching` guard on `claimToken`.
- `MessagingCronRun` records `jobKey`, start/finish, duration, success, stats, and an error summary.

### 3.5 Error handling and logging

- No structured logger library (no Pino/Winston). Logging is `console.*`.
- `utils/mongoRetry.js` provides `redactSensitiveText`, `publicClientMessage`, `safeErrorSummary`, `logDbError`, `cronFailurePayload`, and `retryTransient`.
- `retryTransient` deliberately refuses non-idempotent work (`idempotent !== true`) and only retries transient Mongo errors. **It is not a general-purpose HTTP retry helper** and must not be reused for Graph writes.
- `services/chatbot/chatbotStructuredLog.js` emits JSON log lines and drops keys matching secret patterns. It is a good pattern but is chatbot-specific.
- Cron payloads return sanitized failure information rather than raw errors.

### 3.6 Authentication and authorization

- Admin routes use `requireAdmin` (`Authorization: Bearer <JWT>`, verified with `ADMIN_JWT_SECRET`, then `Admin.findById`).
- Section-level access uses `requireAdminSection(sectionKey, message)`. A Super Admin bypasses; others need the key in `admin.sectionAccess`.
- Section keys are duplicated deliberately in backend `constants/adminSectionKeys.js` and frontend `src/constants/adminSectionAccess.js`; comments require them to stay in sync.
- Public webhooks (Gupshup) do their own verification; they are not behind admin auth.
- There is no API-key or OAuth scope model for machine-to-machine admin access beyond the cron secret.

### 3.7 Tests

- 158 test files under `test/`.
- Integration harness: `test/integration/harness/{setup,db,env,clock,crashHooks}.js` with an in-memory MongoDB.
- Dedicated race/recovery suites: `dispatchCrashRecovery`, `cronOverlap`, `lateWebhookReconcile`, `retryPromotion`, `manualRecoveryOverlap`, `durableJobConsistency`.
- Stress suite: `test/integration/stress/queueFairness.stress.test.js`.
- Unit tests frequently use `MongoMemoryReplSet` when unique indexes or transactions matter (for example `test/crmRateLimit.test.js`).

This is a strong foundation for Phase 1 queue tests: the same harness can simulate crash-after-claim and duplicate webhook delivery.

---

## 4. Reusable components inventory

| Component | Path and key functions | Reuse for support email | Caveats |
|---|---|---|---|
| Webhook ingestion + dedupe | `services/chatbot/whatsappInboundService.js` — `handleInboundWebhook`, `buildInboundMessageFields`, `claimInboundForProcessing`, `recoverStaleProcessingInbound`, `replayPendingInbound` | **High.** Copy the shape: verify → dedupe insert → pending row → claim → process → cron replay | Gupshup-specific parsing, phone-centric, and awaits processing inline |
| Inbound payload sanitation | `utils/gupshupInboundPayload.js` — `sanitizeInboundSnippet`, `buildInboundDedupeKey` | Medium. Reuse the “store a bounded snippet, never the full secret payload” idea | Replace with an email-specific normalizer |
| Durable lease queue | `services/whatsappReminderJobDispatcher.js` — `claimOneJob`, `leaseFreeCondition`, `releaseJobClaim`, `transitionToDispatching`; `models/WhatsAppReminderJob.js` | **Very high.** This is the exact claim/lease/token pattern needed | WhatsApp retry semantics and fields are domain-specific |
| Cron ledger | `models/MessagingCronRun.js`; `routes/cronRoutes.js` — `startCronRun`, `finishCronRun`, `failCron` | High. Mirror for `SupportEmailRun` | `jobKey` enum is closed; do not overload it |
| Cron auth | `utils/cronSecret.js` — `hasCronSecretConfigured`, `isValidCronSecret`; `routes/cronRoutes.js` — `verifyCronSecret` | **Very high.** Reuse the exact verifier | Supports query `key`, `x-cron-key`, and Bearer |
| Admin auth | `middleware/requireAdmin.js` | **Very high** | Loads the admin from Mongo on every request |
| Section authorization | `middleware/requireAdminSection.js`; `constants/adminSectionKeys.js` | **Very high.** Add a `support-email` key | Must also update the frontend key list |
| AI client | `services/ai/llmClient.js` — `chatCompletion`; `services/ai/providers/OpenAiCompatibleProvider.js` — `chatCompletion` | **High.** Reuse transport, timeout, retries, model selection | Helper does not expose `responseFormat` or `tools` |
| Prompt versioning | `services/answerStudio/promptResolver.js` — `resolveStudioPrompt`; `models/AnswerStudioPrompt.js` | Medium–High. Copy the key+version+active-pointer idea if prompts become admin-editable | Answer Studio prompts are platform-specific; do not reuse their text |
| Prompt storage | `utils/systemPromptSettings.js` (`AppSettings` key `flowV3SystemPrompt`, `SystemPromptHistory`) | Medium. Good pattern for admin-editable config | WhatsApp-specific key and file mirroring |
| Google Sheets client | `config/googleSheets.js` | **High.** Reuse the service-account initialization | Singleton created at module load; no retry/telemetry |
| Sheets append | `utils/sheetsService.js` — `appendFormSubmission`; `utils/googleSheetsService.js` — `appendRow`, `updateRow`, `getLastRowNumber` | Medium. Reuse the API call shape | Form-specific row mapping; read-then-append race; no idempotency |
| GridFS storage | `services/resourceStorageService.js` — `uploadToGridFS`, `openDownloadStream`, `deleteFromGridFS`; `controllers/studentResourceController.js` | **High.** Reuse for private attachments behind a new bucket name | Single-buffer upload helper; large files need streaming |
| Redaction/logging | `utils/mongoRetry.js` — `redactSensitiveText`; `services/chatbot/chatbotStructuredLog.js` | High | Neither is email-specific; add email fields deliberately |
| Index safety | `config/mongooseSafety.js`; `scripts/syncCrmIndexes.js`; `scripts/ensureWhatsAppReminderJobUniqueIndex.js` | **Very high.** Mirror the reviewed index-script pattern | Remote `autoIndex` is off; deploying a model does not create indexes |
| Test harness | `test/integration/harness/*`, `test/integration/suites/*` | **Very high.** Reuse for queue and crash tests | Test env must stub Graph and AI, never call real services |

---

## 5. MongoDB assessment

### 5.1 Connection strategy — **VERIFIED**

`config/db.js` defines `MONGO_DRIVER_OPTIONS`:

| Option | Value | Effect |
|---|---|---|
| `maxPoolSize` | 10 | Bounds sockets per Vercel isolate (Atlas connection cap protection) |
| `minPoolSize` | 0 | No idle pool kept warm |
| `maxIdleTimeMS` | 30,000 | Closes idle sockets |
| `serverSelectionTimeoutMS` | 12,000 | Bounds primary selection |
| `socketTimeoutMS` | 45,000 | Detects dead commands |
| `connectTimeoutMS` | 15,000 | Bounds TCP connect |
| `waitQueueTimeoutMS` | 10,000 | Bounds pool wait |
| `bufferTimeoutMS` | 20,000 | Must exceed server selection; otherwise buffered commands fail early |

`connectDB()` uses `createConnectionGate` to share one in-flight attempt, gives an existing client time to recover, and only then closes and replaces it. `openMongo()` wraps connection in `retryTransient({ idempotent: true })`. Fallback URI logic exists for Atlas whitelist failures.

**Assessment:** suitable. For support email, no new connection is needed. Do not create a second Mongoose connection; the cached client is shared by all models.

### 5.2 Index conventions — **VERIFIED**

- Nullable uniqueness uses **partial unique indexes**, not sparse-only indexes:
  - `WhatsAppInboundMessage`: unique `providerMessageId` and unique `dedupeKey`, both with `partialFilterExpression` requiring a non-empty string.
  - `WhatsAppWebhookEvent`: unique sparse `webhookDedupeKey`.
- Compound indexes support queue scans and list pages: `{ processStatus: 1, receivedAt: 1 }`, `{ conversationId: 1, receivedAt: -1 }`, `{ jobKey: 1, startedAt: -1 }`.
- TTL indexes exist where appropriate: `OtpVerification`, `VerifiedPhoneSession`, `WebChatSession`, `ResourceUploadChunk`.
- `config/mongooseSafety.js` patches `mongoose.connect` and forces `autoIndex: false` for every remote URI. `ALLOW_REMOTE_AUTO_INDEX=1` is the explicit override.
- Index scripts (`scripts/syncCrmIndexes.js`) refuse `NODE_ENV=production` and every non-local URI. Another script (`ensureWhatsAppReminderJobUniqueIndex.js`) performs a duplicate preflight and a manual unique-index creation.

**Consequence for Phase 1:** every new collection’s indexes exist only as schema declarations until a reviewed script is run against the target database. The dedupe guarantee is not real until the unique indexes are created. Phase 1 must ship a dry-run-first index script and a runbook. Production index creation is a change-management step, not a deploy side effect.

### 5.3 Deduplication — **VERIFIED PATTERN**

The WhatsApp inbound path inserts a provider event row with a unique dedupe key, then inserts the message row with its own unique dedupe key. A duplicate-key error is treated as success (`dedupe: true`). This is the correct shape for Graph notifications:

```text
notification (subscriptionId + resource + changeType)
        -> unique event insert
        -> unique email insert (graphMessageId / internetMessageId)
        -> unique processing job insert (emailId + stage)
```

**Recommendation:** add a third, content-level *flag* (same sender + normalized subject + body hash within a window) that marks likely duplicates for review but does not silently drop them. Forwarded and re-sent emails legitimately have different `internetMessageId` values.

### 5.4 Atomic updates and queue suitability — **VERIFIED**

The reminder queue proves MongoDB is adequate as a durable queue at this scale:

- Single-document atomic `findOneAndUpdate` claims prevent double processing.
- Lease expiry recovers crashed workers without a separate scheduler.
- Claim tokens prevent a stale worker from overwriting a newer claim.
- `$inc` attempts and guarded state transitions make retries safe.
- A cron sweep provides at-least-once delivery.

**Suitability for 2,000+ emails/day: yes.** Estimated 24,000 writes/day (12 per email) is under 0.3 writes/second average and roughly 12 writes/second at a 60/minute burst. That is trivial for Atlas. The queue is not the bottleneck; AI latency and Graph concurrency are.

**Constraints to design around:**

- Polling latency: a queue row is picked up by the next cron tick (up to ~60 seconds). Acceptable for support email; not for chat.
- No exactly-once delivery: stages must be idempotent and keyed.
- No push/priority: add `priority` and `nextAttemptAt`; process overdue first.
- Multiple cron invocations can overlap: use a single-flight lease lock.
- 16 MB BSON document limit: never store attachments or full raw MIME in a ticket/email document.

### 5.5 Transactions

**VERIFIED:** no `startSession`/`withTransaction` usage exists in services or controllers. Atlas is a replica set in practice, so transactions are available, but the codebase deliberately prefers idempotent single-document operations.

**Recommendation:** keep that style. Create tickets with a deterministic unique dedupe key, then link the email to the ticket. A crash between the two is repaired by retrying the upsert, not by a multi-document transaction.

### 5.6 GridFS

**VERIFIED:** `services/resourceStorageService.js` already wraps `GridFSBucket` (`student_resources`) with `uploadToGridFS`, `openDownloadStream`, and `deleteFromGridFS`. `controllers/studentResourceController.js` enforces a 20 MB limit and chunked upload sessions.

**Assessment:** GridFS is a legitimate zero-new-infrastructure option for email attachments. It is not free: attachment bytes inflate Atlas storage, backup size, and restore time. Chapter 9 quantifies this.

---

## 6. AI assessment

### 6.1 Provider and model — **VERIFIED CODE PATH**

`services/ai/llmClient.js`:

- `defaultProvider = new OpenAiCompatibleProvider()` reads `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` at call time.
- `buildChatCompletion(provider)` returns a helper that accepts either `systemPrompt` + `userPrompt` or a full `messages` array.
- `chatCompletion` returns `{ content, model, usage }`.
- A separate `collegeComparisonChatCompletion` uses `COLLEGE_COMPARISON_*` keys and does not fall back to `LLM_API_KEY`.

`services/ai/providers/OpenAiCompatibleProvider.js`:

- Lazily creates an OpenAI SDK client with `timeout: LLM_TIMEOUT_MS || 20000` and `maxRetries: LLM_MAX_RETRIES || 2`.
- Supports `messages`, `temperature`, `maxTokens`, `timeoutMs`, `maxRetries`, `tools`, `toolChoice`, and `responseFormat`.
- Returns `text`, `model`, `toolCalls`, `finishReason`, and `rawMessage`.
- Logs only debug markers (`aiDebugLog`), not prompt or response content.

**Not verified:** the production base URL, model, context window, vision support, JSON-mode support, rate limits, and data-retention terms. `.env.example` shows an NVIDIA-compatible example (`https://integrate.api.nvidia.com/v1`, `openai/gpt-oss-20b`), but the production `.env` was not read.

### 6.2 Prompt management — **VERIFIED**

Three patterns coexist:

1. **Code files:** `services/ai/prompts/collegeComparison*.system.{js,md}`.
2. **MongoDB setting + file mirror:** `utils/systemPromptSettings.js` stores the WhatsApp system prompt under `AppSettings.key = 'flowV3SystemPrompt'` and appends versions to `SystemPromptHistory`.
3. **Versioned prompt collection:** `models/AnswerStudioPrompt.js` enforces unique `{ key, version }` and a partial unique index for one active prompt per platform; `services/answerStudio/promptResolver.js` prefers the active DB prompt and falls back to a code default.

**Recommendation for email:** start with a code-reviewed prompt module and a `promptVersion` constant recorded on every AI run. If support staff must edit prompts, reuse the Answer Studio versioned-prompt pattern later. Do not allow an admin-edited prompt to change output schema without validation.

### 6.3 Structured output — **GAP**

**VERIFIED:** `responseFormat` is passed through by the provider but is not used anywhere in the repository. The `llmClient.chatCompletion` helper does not expose `responseFormat`, `tools`, or `toolChoice`; it only forwards system/user messages, temperature, max tokens, timeout, and retries.

Therefore:

- Native JSON-schema enforcement is **not currently available** through the shared helper.
- Whether the configured model/provider honors `response_format` is **UNRESOLVED**.
- Phase 4 must either extend `llmClient` to pass `responseFormat` (small, additive) or instantiate the provider directly, and must still validate the parsed JSON locally.

**Recommended classification contract (not implemented):**

```json
{
  "category": "admissions | fees | schedule | technical | refund | certificate | document | complaint | other",
  "subCategory": "string|null",
  "priority": "low | normal | high | urgent",
  "sentiment": "positive | neutral | negative",
  "confidence": 0.0,
  "student": {
    "name": "string|null",
    "phone": "10-digit string|null",
    "email": "string|null",
    "course": "string|null",
    "exam": "string|null"
  },
  "enquiry": {
    "summary": "string",
    "requestedAction": "string|null",
    "deadline": "ISO date|null"
  },
  "flags": ["possible_spam", "prompt_injection_suspected", "attachment_unreadable"]
}
```

Validation rules: enums only, phone `^[0-9]{10}$` after normalization, email syntax, bounded string lengths, confidence clamped to `[0,1]`, unknown category mapped to `other` plus `needs_review`. A repair retry (one attempt) may fix malformed JSON; a second failure becomes a failed AI run, not a guessed ticket.

### 6.4 Error handling and retries — **VERIFIED**

- Transport retries: OpenAI SDK `maxRetries` (default 2).
- Timeout: 20 seconds default; callers can override.
- `services/answerStudio/generationService.js` maps timeouts to 504 and provider failures to 502, and refuses to store an answer over the limit.
- No application-level circuit breaker, no provider failover, no token/cost budget enforcement, no central AI-run ledger for existing chatbot calls.

**Recommendation:** AI runs for email must be recorded with `model`, `promptKey`, `promptVersion`, `inputHash`, `usage`, `latencyMs`, `outcome`, and a bounded `rawResponse`. Never log the raw email body or the raw response. Add a per-run and per-day token budget to prevent runaway cost.

### 6.5 Reusability verdict

**High** for transport and model selection. **Medium** for prompt management. **Low** for structured output until the helper is extended and the provider capability is proven. Email classification is a new prompt and a new validator, not a reuse of the WhatsApp prompt.

---

## 7. Google Sheets assessment

### 7.1 Authentication — **VERIFIED**

`config/googleSheets.js` initializes a singleton `google.sheets({ version: 'v4', auth })` from either:

- `GOOGLE_SHEETS_CREDENTIALS_JSON` (preferred, works on Vercel), or
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` / `GOOGLE_APPLICATION_CREDENTIALS` (local file).

Scope is `https://www.googleapis.com/auth/spreadsheets`. If neither is configured, it warns and exports `null`.

The expected service account in log messages is `sheets-sync@guidexpert.iam.gserviceaccount.com`; this is informational, not a guarantee of the current production account.

### 7.2 Existing implementations — **VERIFIED**

There are two independent implementations:

1. `utils/googleSheetsService.js`
   - Hard-coded tab `Formresponses`.
   - `appendRow(doc)` calls `getLastRowNumber()` (reads `A:A`) and then `values.append` for `A:H`. Two API calls per row; a read-then-append race.
   - `updateRow(rowNumber, doc)` writes a fixed `A:H` range.
   - `markRowDeleted` writes a `DELETED` marker in column I.
   - All errors are logged and swallowed; returns `null`/`false`.

2. `utils/sheetsService.js`
   - Generic `appendFormSubmission(sheetId, submission, range)`.
   - Maps a `FormSubmission` to a fixed 16-column row.
   - “Best-effort: logs errors, never throws.”

`controllers/formController.js` calls `appendToSheetIfConfigured` after submit, catching and logging failures.

**Assessment:** the auth setup is reusable; the row writers are not suitable for tickets. There is **no retry with backoff, no batching, no idempotency, and no reconciliation**. A retry after an ambiguous timeout can append a duplicate row.

### 7.3 Quotas and performance — **VERIFIED (vendor docs)**

- 300 read requests/minute/project and 60 read requests/minute/user/project.
- 300 write requests/minute/project and 60 write requests/minute/user/project.
- A batch request, including its subrequests, counts as **one** API request.
- Recommended maximum payload is 2 MB.
- Exponential backoff is the documented response to 429.

At 2,000 tickets/day, average write load is ~1.4/minute. A single append per ticket is well inside quota. The existing `getLastRowNumber + append` pattern doubles calls and can exceed 60/minute during a burst. Batching 20 rows per `values.append` reduces this to one write per batch.

### 7.4 Recommended integration shape

- Mongo remains the source of truth; Google Sheets is a **projection**, never an input.
- New dedicated spreadsheet/tab configured by `SUPPORT_EMAIL_SHEET_ID` and `SUPPORT_EMAIL_SHEET_TAB`. **Do not** reuse `GOOGLE_SHEET_ID`.
- `GoogleSheetsSyncJob` outbox with a unique `{ ticketId, spreadsheetId, tab }` key, lease fields, `attempts`, `nextAttemptAt`, `lastError`, and `rowNumber`.
- Append rows in batches; store the returned updated range to derive the row number for later updates.
- On timeout ambiguity, perform a bounded read of column A for the batch range to confirm whether the rows exist before retrying.
- After the first successful append, subsequent ticket edits use `values.update` on the stored row range, not another append.
- Retry with truncated exponential backoff and jitter; after 5 attempts, mark `exhausted` and surface on the admin dashboard.
- Never block ticket creation on Sheets availability.

---

## 8. Vercel deployment assessment

### 8.1 Verified configuration

| Item | Value | Source |
|---|---|---|
| Project | `gxp-backend` (`prj_67GPp7HIKGvkLhs8aICWmNfzKwgp`) | `.vercel/project.json` |
| Build | `@vercel/node` from `server.js` | `vercel.json` |
| Function max duration | **60 seconds** | `vercel.json` → `builds[0].config.maxDuration` |
| Cron cadence | Every minute, 8 jobs | `vercel.json` |
| Production API alias | `gxp-new-backend.vercel.app` | frontend rewrite |
| Node runtime on Vercel | Not pinned in `vercel.json` | **UNRESOLVED** |
| Function memory / region | Not in repository | **UNRESOLVED** |
| Deployment Protection | Not inspectable from repository | **UNRESOLVED — Phase 2 blocker if enabled** |

### 8.2 Platform limits — **VERIFIED (vendor docs, 2026)**

- Vercel Pro: default function duration 300 s, maximum 800 s, extended beta 1,800 s (30 min) for supported runtimes.
- Vercel Cron on Pro: minimum interval 1 minute, per-minute scheduling precision, up to 100 cron jobs per project.
- The repository’s own 60-second cap is therefore a self-imposed limit, not a platform ceiling.
- Vercel does **not** provide a continuously running background worker. Cron invokes a function; the function is terminated at its duration limit.

### 8.3 Webhook feasibility

**Feasible, with conditions:**

- Graph notifications are small JSON payloads; the app’s 15 MB JSON body limit is not a constraint.
- Graph validation requires echoing `validationToken` as `text/plain` within **10 seconds**.
- The global DB gate runs before the route. Cold start + Atlas connect can approach the 10-second budget. A narrow validation bypass is required.
- The webhook URL must be publicly reachable **without** Vercel authentication. If Deployment Protection is enabled, Microsoft receives a 401 and subscription creation fails.
- Use a stable production domain/alias, not a per-deployment preview URL.

**Recommended webhook behavior:**

1. If `validationToken` is present: `res.type('text/plain').send(token)` immediately, no DB, no logging of the token.
2. Otherwise: validate `clientState` in constant time, validate `tenantId`, reject unknown subscription IDs, insert a dedupe event, enqueue email IDs, return **202**.
3. If the enqueue write fails, return 503 so Graph retries; idempotency handles duplicates.
4. **Do not call Graph from the webhook.** Fetching the message in the cron worker keeps the webhook fast and centralizes the four-concurrent-request mailbox budget.

### 8.4 Does durable background processing need separate infrastructure?

**No, not at 2,000/day.** The existing Mongo lease queue + one-minute cron is sufficient, provided that:

- Work is batched and time-budgeted (for example, stop at 40–45 seconds).
- Claims are atomic and leases expire.
- A single-flight lock prevents overlapping cron invocations from duplicating Graph/AI work.
- Stages are idempotent and resumable.

**When to revisit:** sustained backlog that one invocation cannot drain, a need for sub-minute latency, AI p95 latency that makes 60-second invocations inadequate, or attachment parsing that exceeds function memory. At that point, a small always-on worker (Railway/Fly/Render) or Vercel Queues/Workflows becomes justified. Redis/BullMQ is not justified by the stated volume and would add a second state store to operate.

### 8.5 Single-function implications

Because all routes share one function:

- Raising `maxDuration` affects every route, including public form submissions.
- A long-running email batch competes with user traffic on the same isolate.
- Memory-heavy attachment parsing can affect other requests on that instance.
- Fluid Compute may reuse an instance and process concurrent invocations; module-level caches (Graph token, Sheets client) are per instance.

**Recommendation:** keep the function cap at 60 seconds initially, budget email work to ~45 seconds, and keep per-email memory bounded. Consider splitting email processing into its own function only if measured contention appears.

---

## 9. Scalability analysis

All volume figures below are **ESTIMATES** derived from the 2,000/day requirement. They must be replaced by measurements in Phase 3 before capacity is finalized.

### 9.1 Workload model

| Metric | Value | Basis |
|---|---|---|
| Emails/day | 2,000 | Requirement (not measured) |
| Average/hour | 83 | Arithmetic |
| Average/minute | 1.39 | Arithmetic |
| Business-hours average/minute (70% of volume in 10 hours) | 2.33 | Assumption |
| Design peak/minute | 60 | Assumption: ~25× average for a 10-minute burst |
| Graph calls/email | ~3 | Estimate: delta amortized + message GET + attachment list/download |
| Graph calls/day | ~6,000 | Estimate |
| Graph mailbox limit | 10,000 requests/10 min; 4 concurrent | Microsoft docs |
| AI calls/day | ~2,200 | One per email + 10% retry |
| Mongo writes/day | ~24,000 | 12 per email estimate |
| Attachment volume/day (medium) | ~840 MB | 35% × 1.5 files × 800 KB |
| Attachment volume/month (medium) | ~25 GB | 30-day arithmetic |

### 9.2 Capacity math

**Graph.** 6,000 calls/day is ~0.07 calls/second average. At a 60/minute burst, 180 calls/minute is 18% of the 1,000/minute mailbox allowance. The binding constraint is **four concurrent requests per app per mailbox**, not total volume. A single Graph worker with a local concurrency of 4 is sufficient; at ~250 ms per call, that is ~16 calls/second, far above the burst requirement.

**AI.** One 6-second call per email at concurrency 4 yields ~40 emails/minute. A 60/minute burst needs ~6–8 concurrent calls. Use a separate AI concurrency pool of 8. At 2,200 calls/day and 6 seconds each, total AI time is ~3.7 hours at concurrency 1 or ~28 minutes at concurrency 8.

**Mongo.** 24,000 writes/day is ~0.28/second average; a 60/minute burst at 12 writes each is ~12 writes/second. Well within Atlas capacity. The connection pool is 10 per isolate; keep per-invocation DB concurrency below that.

**Queue worker.** A 45-second budget with 8-way AI concurrency and 4-way Graph concurrency can drain roughly 40–60 emails/minute, matching the design peak. Average load needs ~2 emails/minute. One cron invocation per minute is sufficient.

### 9.3 Bottlenecks, in order

1. **AI latency and provider rate limits** — the largest unknown. A 6-second p50 can become 20 seconds at p95; a 60/minute burst with 20-second p95 needs ~20 concurrent calls. Measure in Phase 4.
2. **Graph four-request concurrency** — manageable with one worker and a local semaphore. Do not let multiple isolates fetch in parallel without a distributed cap.
3. **Attachment parsing memory/CPU** — PDF and OCR workloads can exceed function memory. Cap file size/pages and measure.
4. **Vercel 60-second invocation** — solved by batching and resumable stages, not by raising the cap blindly.
5. **Mongo** — not a bottleneck at this scale.
6. **Google Sheets** — not a bottleneck with batching; without batching, a burst can exceed 60 writes/minute.

### 9.4 Attachment storage scenarios

| Scenario | Emails with attachments | Files/email | Avg file size | Per day | Per 30 days |
|---|---|---|---|---|---|
| Low | 20% | 1.0 | 300 KB | 120 MB | 3.6 GB |
| Medium | 35% | 1.5 | 800 KB | 840 MB | 25 GB |
| High | 50% | 2.0 | 2 MB | 4.0 GB | 120 GB |

Add extracted text in Mongo: assume 2–10% of file size, capped at 200 KB per email. At medium volume that is ~20–170 MB/day, which is manageable.

**Critical implication:** at medium/high volume, GridFS will materially grow the Atlas cluster and its backups. Typical Atlas tier storage is 10 GB (M10), 20 GB (M20), 40 GB (M30), but the current tier is **UNRESOLVED**. Phase 3 must measure the real distribution before choosing storage. A retention policy (for example, delete raw binaries after 90 days while keeping extracted text and metadata) may be the cheapest control.

### 9.5 AI token and cost worksheet

Estimated input per email:

- Email body: capped at 8,000 characters ≈ 2,000 tokens.
- Attachment text: capped at 12,000 characters ≈ 3,000 tokens.
- System prompt + schema + few-shot examples: ~1,500 tokens.
- **Total input:** ~6,500 tokens/email.
- Output: ~600 tokens/email.

Daily input ≈ 13 million tokens; daily output ≈ 1.2 million tokens. Cost depends entirely on the production model. At a low-cost tier ($0.15/M input, $0.60/M output) this is roughly **$3/day**; at a premium tier ($2.50/M input, $10/M output) it is roughly **$45/day**. These are **ESTIMATES** for budgeting only; verify the actual rate card and provider.

### 9.6 Recovery risks

| Failure | Consequence | Mitigation |
|---|---|---|
| Missed webhook notification | Email not ingested until reconciliation | Delta query on every cron tick or every 5 minutes |
| Subscription expires | Notifications stop | Store expiry; renew at least 24 h before; lifecycle notifications |
| Delta link expires / `410 resyncRequired` | Cannot continue incremental sync | Re-baseline from `lastSuccessfulSyncAt - 10 min` with a `receivedDateTime` filter; never from mailbox history |
| Cron invocation dies mid-batch | Jobs remain claimed | Lease expiry + stale recovery on the next tick |
| Duplicate notifications | Duplicate rows/tickets | Unique indexes + deterministic job keys + idempotent stages |
| Poison message (parser/AI repeatedly fails) | Endless retries | Attempt cap + dead-letter state + admin requeue |
| Attachment partially downloaded | Ticket missing content | Per-attachment state machine; retry only incomplete files |
| Sheets timeout after append succeeded | Duplicate row on retry | Store row number; bounded read reconciliation; update instead of append |
| Atlas connection exhaustion | 503s across the API | Keep pool at 10; cap per-invocation concurrency; monitor |

### 9.7 Scale triggers for new infrastructure

Introduce a separate worker or queue only if one of these is observed for 7 consecutive days:

- Backlog age p95 > 10 minutes at normal volume.
- More than 50% of cron invocations hit the time budget with pending work.
- AI p95 latency > 15 seconds and cannot be reduced by batching/model choice.
- Attachment parsing causes function OOM or affects unrelated API latency.
- A hard requirement for sub-minute ticket creation appears.

---

## 10. Microsoft Graph readiness

### 10.1 Known configuration

| Item | Value | Status |
|---|---|---|
| Application name | GuideXpert Support Email Automation | Provided |
| Client (application) ID | `64db4683-efa3-4252-859c-f2fe20282fcc` | Provided — non-secret identifier |
| Tenant ID | `e055d510-a802-4f40-9ca9-b19374d6e0f7` | Provided — non-secret identifier |
| Mailbox | `support@niatindia.com` | Provided |
| Mailbox type | Shared mailbox | Provided |
| Permission | `Mail.Read` application permission, admin consent granted | Provided |
| Credential | Not created | **PENDING** |
| Exchange mailbox scoping | Not configured | **PENDING — critical** |
| Authentication verification | Not performed | **PENDING** |
| Graph subscription | Not created | **PENDING** |
| Delta cursor | Not created | **PENDING** |
| Renewal job | Not created | **PENDING** |

### 10.2 Authentication design

Use the OAuth 2.0 client-credentials flow:

```text
POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
grant_type=client_credentials
client_id={clientId}
scope=https://graph.microsoft.com/.default
client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
client_assertion={signed JWT}
```

**RECOMMENDATION:** use a **certificate credential**, not a client secret.

- Certificates are harder to exfiltrate from logs and accidental config dumps.
- Store the certificate (base64 PFX) and its password in Vercel encrypted environment variables only.
- Load and parse once per isolate; never write it to disk.
- Cache the access token in module memory with a safety margin (refresh 5 minutes before `expires_in`).
- Do not persist tokens in MongoDB.
- Record only `tokenAcquiredAt`, `expiresAt`, and success/failure metadata for observability.

**If a client secret is used instead:** limit lifetime to 6–12 months, store it only in Vercel, rotate on a calendar, and add a secret-expiry reminder. Never put it in `.env.example`, source, docs, or logs.

**Dependency note:** `@azure/msal-node` would simplify certificate handling but is not currently installed. A client assertion can also be built with Node’s built-in `crypto` and `fetch`, avoiding a new dependency. Decide in Phase 2; if a dependency is added, it must be justified and pinned.

### 10.3 Mailbox scoping — the critical security control

**VERIFIED from Microsoft documentation (2026):**

- Exchange Online **RBAC for Applications** replaces Application Access Policies.
- An application can have both an unscoped Entra permission and a scoped Exchange RBAC assignment.
- **Permissions are additive.** If `Mail.Read` remains granted tenant-wide in Entra, a scoped Exchange assignment does **not** constrain it. Microsoft explicitly says to remove the unscoped Entra assignment; otherwise the union results in no effective resource scoping.
- Changes to app permissions are subject to a cache that varies from **30 minutes to 2 hours**.

**Therefore the current posture — tenant-wide `Mail.Read` admin consent — does not satisfy “restrict production access to the support mailbox only.”**

**RECOMMENDED scoping procedure (Exchange Online PowerShell):**

1. Create a mail-enabled security group, for example `GXP-Support-Email-Readers`, containing only `support@niatindia.com` as a **direct** member. Nested group members are out of scope in RBAC for Applications.
2. Create the Exchange service-principal pointer:

   ```powershell
   New-ServicePrincipal `
     -AppId 64db4683-efa3-4252-859c-f2fe20282fcc `
     -ObjectId <service-principal-object-id-from-Entra-Enterprise-Applications> `
     -DisplayName "GuideXpert Support Email Automation"
   ```

   Use the Enterprise Applications **Object ID**, not the App Registrations object ID.

3. Create a management scope over the group’s distinguished name:

   ```powershell
   New-ManagementScope `
     -Name "GXP Support Mailbox" `
     -RecipientRestrictionFilter "MemberOfGroup -eq '<group-distinguished-name>'"
   ```

4. Assign only the read role:

   ```powershell
   New-ManagementRoleAssignment `
     -App <service-principal-object-id> `
     -Role "Application Mail.Read" `
     -CustomResourceScope "GXP Support Mailbox"
   ```

5. **Remove the tenant-wide `Mail.Read` application grant from Entra** (or replace it with the scoped model). Do not grant `Mail.ReadWrite`, `Mail.Send`, `Mail.ReadWrite.Shared`, or `Mail.Send.Shared`.
6. Wait for the permission cache (30 minutes to 2 hours), then verify:

   ```powershell
   Test-ServicePrincipalAuthorization `
     -Identity <service-principal-object-id> `
     -Resource support@niatindia.com
   ```

7. Verify a negative case: the same token must receive **403** for a different mailbox, for example `GET /users/another-user@niatindia.com/messages`.

**Mandatory Architecture:** Exchange Online RBAC for Applications is the only authorized production model. Application Access Policies (`New-ApplicationAccessPolicy`) are obsolete and forbidden. If administrators previously consented to tenant-wide `Mail.Read` in Entra ID, that grant must be removed; otherwise it bypasses Exchange scoping entirely.

**Additional controls:**

- Use a separate Entra app registration per environment (dev/staging/prod) so a staging mistake cannot read production mail.
- Do not grant `Mail.Send`; this makes “never send automatic replies” enforceable at the permission layer.
- Do not grant `Mail.ReadWrite`; this makes “never mark as read, move, or delete” enforceable at the permission layer.
- Add a contract test that the Graph client only issues `GET` requests against `/messages` and `/attachments` (plus `POST/PATCH/DELETE` only on `/subscriptions`).

### 10.4 Ingestion design: webhook plus delta

Use **both** mechanisms. Neither alone is sufficient:

- **Webhook** gives low latency and avoids polling.
- **Delta query** recovers missed notifications, expired subscriptions, and deployment gaps.

**Webhook contract:**

```text
POST /webhook/graph
  ?validationToken=...        -> 200 text/plain, echo token, <10 s
  body { value: [ ... ] }     -> validate, dedupe, enqueue, 202
```

Validation rules:

- Constant-time compare `clientState` against a secret from env.
- Verify `tenantId` equals the expected tenant.
- Ignore unknown `subscriptionId` values.
- Bound the notification array (for example, 100 per request).
- Dedupe on `subscriptionId + resource + changeType + tenantId` (and notification `id` if present).
- Always fetch the message by ID from Graph; never trust notification content.
- Return 202 even when the email was already enqueued.
- Return 503 only when the durable enqueue write failed.

**Delta contract:**

```text
GET /users/support@niatindia.com/mailFolders/inbox/messages/delta
    ?changeType=created
    &$select=id,internetMessageId,conversationId,receivedDateTime,subject,
             from,toRecipients,ccRecipients,hasAttachments,bodyPreview,isRead
    &$top=50
```

- Follow `@odata.nextLink` until `@odata.deltaLink`.
- Persist the `deltaLink` per mailbox/folder after each fully processed page.
- Bound each cron run by pages or time (for example, 3 pages or 30 seconds).
- Ignore `@removed` entries for content purposes; mark the local record as `sourceRemoved` if it already exists. Never delete the local copy solely because the source changed.
- Ignore `isRead` updates. Do not act on them.
- On `410 resyncRequired`, re-baseline from `lastSuccessfulSyncAt - 10 minutes` with a `receivedDateTime` filter.

**Delta query limits (vendor docs):** supports `$select`, `$top`, and `$expand`; `$filter` supports only `receivedDateTime ge|gt {value}`; applying `$filter` returns at most 5,000 messages; `$orderby` supports only `receivedDateTime desc`; no `$search`.

### 10.5 Historical-email exclusion — hard requirement

The requirement “never import historical emails” must be enforced at three layers:

1. **Policy record.** A singleton `EmailIngestionPolicy` document with `activationAt` (UTC), `mailbox`, and `baselineCompletedAt`.
2. **Baseline delta.** The first delta call must include `$filter=receivedDateTime gt {activationAt}` and `changeType=created`. Do not issue an unfiltered initial delta, which returns the entire folder.
3. **Per-message guard.** Before storing an email, reject and audit any message with `receivedDateTime < activationAt - 5 minutes` (clock-skew allowance). Record only metadata (`graphMessageId`, `receivedDateTime`, reason); do not store the body.

**Activation ordering:**

```text
1. Create subscription (notifications begin).
2. Record activationAt = now (UTC).
3. Run filtered baseline delta and persist deltaLink.
4. Enable queue processing.
```

If notifications arrive before the baseline completes, they are enqueued and later deduped against the delta result. If the baseline fails, disable processing rather than starting from an unfiltered sync.

**Test requirement:** fixture messages dated before and after `activationAt`; assert that only messages at or after the boundary create email rows, and that pre-boundary messages produce only a `skipped_historical` audit record.

### 10.6 Subscriptions and lifecycle

- Resource: `/users/support@niatindia.com/mailFolders('inbox')/messages`.
- Change type: `created`.
- Maximum subscription lifetime for Outlook messages: **10,080 minutes (under 7 days)**. Rich-notification subscriptions are shorter (under 1 day); use basic notifications.
- Renew at least 24 hours before expiry; a daily cron is sufficient, but an hourly check is safer.
- Store `subscriptionId`, `expirationDateTime`, `clientStateHash`, `notificationUrl`, `lifecycleNotificationUrl`, and status.
- Handle lifecycle events:
  - `reauthorizationRequired` → reauthorize/renew.
  - `subscriptionRemoved` → recreate and run delta.
  - `missed` → run delta immediately.
- A maximum of 1,000 active subscriptions per mailbox exists for all applications; one subscription is far below the limit.
- Deleting a subscription on deactivation is allowed. It does not delete or move email.

### 10.7 Rate limits and throttling

**VERIFIED (Microsoft docs):** Outlook service limits are per app ID + mailbox combination:

- 10,000 API requests in a 10-minute period.
- **Four concurrent requests.**
- 150 MB upload per 5 minutes (not relevant for read-only ingestion).

**Handling:**

- Honor `429` and `Retry-After`.
- Use exponential backoff with jitter for 5xx and network errors.
- Never retry a 401/403 blindly; refresh the token once for 401, then fail.
- Use `$select` and delta paging to reduce payloads.
- Use JSON batching only if it simplifies attachment listing; remember subrequests count individually for throttling and the batch is not atomic.
- Centralize Graph calls in one worker with a local concurrency of 4 to avoid cross-isolate overrun.

### 10.8 Attachment retrieval

- List attachments with `GET /users/{mailbox}/messages/{id}/attachments?$select=id,name,contentType,size,isInline`.
- Download file attachments with `GET /users/{mailbox}/messages/{id}/attachments/{attachmentId}/$value`.
- Skip inline signature images by default (`isInline = true`) unless the business requires them.
- Enforce a per-file cap (for example, 10 MB) and a per-message total cap (for example, 25 MB).
- Microsoft documents attachment sizes up to 150 MB for message attachments in general; the practical cap should be driven by the mailbox’s send/receive limits and by function memory, not by the maximum.
- Never follow `referenceAttachment` URLs (SharePoint/OneDrive links). They are outside the mailbox and outside the granted scope. Record the link metadata only.
- Never download remote images referenced by the HTML body.

### 10.9 Readiness checklist (no secrets recorded)

| # | Check | Expected result | Status |
|---|---|---|---|
| G1 | Client-credentials token request succeeds with the certificate/secret | `200`, access token with Graph audience | PENDING |
| G2 | `GET /users/support@niatindia.com/messages?$top=1` succeeds | `200` | PENDING |
| G3 | Same token against another mailbox | `403` | PENDING |
| G4 | `Test-ServicePrincipalAuthorization` for the support mailbox | `InScope = True` for `Application Mail.Read` | PENDING |
| G5 | Unscoped Entra `Mail.Read` removed | Confirmed in Entra app permissions | PENDING |
| G6 | `POST /subscriptions` succeeds from the production URL | `201` with `expirationDateTime` | PENDING |
| G7 | Validation handshake responds under 10 s from a cold start | `200 text/plain` | PENDING |
| G8 | A test email sent after activation creates exactly one row | 1 row, no duplicate | PENDING |
| G9 | A pre-activation email is not imported | 0 rows, one skip audit | PENDING |
| G10 | Graph client issues no `PATCH /messages` | Static test passes | PENDING |
| G11 | 429 handling honors `Retry-After` | Retry succeeds without data loss | PENDING |
| G12 | Delta `410` re-baselines without historical import | Bounded recovery | PENDING |

---

## 11. Security assessment

### 11.1 Threat model

| ID | Threat | Likelihood | Impact | Current control | Required control |
|---|---|---|---|---|---|
| S1 | Tenant-wide `Mail.Read` allows reading every mailbox | High (current state) | Critical | Entra consent only | Exchange RBAC scoping + remove unscoped grant |
| S2 | Credential leak from source/config/logs | Medium | Critical | `.env` gitignored | Certificate in Vercel env; secret scanning; rotation; no logging |
| S3 | Prompt injection in email body/attachment | High | High | None | Treat content as data; schema-only output; no tools; injection flags |
| S4 | Malicious attachment (macro, exploit, zip bomb) | Medium | High | None | MIME/magic validation, allowlist, size/entry caps, no execution, AV status |
| S5 | Unauthorized admin views student PII | Medium | High | Admin JWT + section keys | New `support-email` section; audit reads/exports; least privilege |
| S6 | PII in logs | Medium | High | Some redaction helpers | Structured logs with IDs/hashes only; no bodies/subjects/phones |
| S7 | Duplicate processing creates duplicate tickets | High without design | Medium | Proven dedupe patterns | Unique indexes + deterministic keys + idempotent stages |
| S8 | Incorrect AI classification | High | Medium | None | Confidence thresholds, review queue, human override, evaluation set |
| S9 | Student data retained too long | Medium | High | TTL on some collections | Retention policy + deletion jobs + legal review |
| S10 | Webhook spoofing | Medium | High | None yet | `clientState` + `tenantId` validation + no trust in payload |
| S11 | Attachment exposure via public URL | Medium | High | None yet | Private GridFS + authenticated short-lived download tokens |
| S12 | Model provider retains/trains on PII | Unknown | High | None verified | DPA/zero-retention confirmation before Phase 4 |
| S13 | Over-broad admin export | Medium | High | Section gate | Export limits, audit, optional approval |
| S14 | Replay of old emails | Medium | Medium | None | Activation cursor + per-message date guard |

### 11.2 Mailbox authorization

The single most important finding of this audit is **S1**. The stated posture (tenant-wide `Mail.Read` admin consent) is broader than the business requirement. Section 10.3 defines the remediation. Until it is complete, Phase 2 must not run against production mail.

Additional rules:

- One app registration per environment.
- No `Mail.Send`, `Mail.ReadWrite`, `Mail.ReadWrite.Shared`, or `Mail.Send.Shared`.
- No delegated permissions; app-only only.
- The app’s service principal should not own or administer anything else.
- Restrict who can edit the app registration and who can run Exchange role assignments.
- Record the permission model and the negative test (403 on another mailbox) in the runbook.

### 11.3 Credential storage

- Vercel encrypted environment variables only (Production/Preview/Development scopes as appropriate).
- Never in `.env.example`, source, docs, tests, fixtures, or screenshots.
- No credential values in error messages or logs. Graph SDK errors can include request IDs; that is acceptable. Do not log request headers.
- Rotate on a schedule and immediately on suspected exposure.
- Add a CI/secret-scanning check before Phase 9.
- Use different credentials for staging and production, even if the app registration is shared.

### 11.4 Email prompt injection

Email content is **untrusted input**. Controls:

1. **Instruction hierarchy.** The system prompt states that the email and attachment text are data, never instructions. It explicitly forbids following requests to send mail, change classification rules, reveal prompts, or access other records.
2. **No tool use.** The classification call has no tools and no ability to act. It returns JSON only.
3. **Delimiting and escaping.** Wrap content in explicit tags, strip HTML, decode entities, remove control characters, and cap length.
4. **No cross-record context.** Send only the current email and its extracted attachment text. Never include other tickets, student records, or secrets.
5. **Schema-only output.** Validate enums, types, and lengths. Unknown values become `other` + `needs_review`.
6. **Injection heuristics.** Flag phrases such as “ignore previous instructions”, “system prompt”, “send this to”, “classify as”, and unusual hidden text. A flag routes to review; it does not replace schema validation.
7. **No action from model output.** The model cannot create a ticket directly, change a status, send an email, or call an API.
8. **Regression corpus.** Maintain a set of injection attempts in tests and re-run on every prompt/model change.

### 11.5 Attachment security

- **Allowlist:** PDF, PNG/JPEG (and possibly WEBP), DOCX, XLSX only.
- **Reject:** executables, scripts, HTML, SVG, archives (ZIP/RAR/7z), macro-enabled Office (`.docm`, `.xlsm`), password-protected files, and `referenceAttachment` links.
- **Verify magic bytes**, not just the declared `contentType` or file extension.
- **Caps:** file size, total message size, attachment count, PDF page count, DOCX/XLSX uncompressed entry count and total uncompressed size, image dimensions.
- **No execution:** parse with libraries only; never invoke Office, a shell, or a renderer.
- **Private storage:** GridFS bucket dedicated to support email, or a private object store. No public bucket, no public URL.
- **Download:** authenticated admin endpoint, short-lived signed token, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, no inline rendering, no HTML.
- **Scanning:** Microsoft Defender for Office 365 scans inbound mail at the service layer (assumption to verify). Record a `scanStatus`; if scanning is unavailable, quarantine attachments and surface them for manual review rather than silently processing.
- **Retention:** delete raw binaries on schedule; keep extracted text/metadata only as long as needed.

### 11.6 Unauthorized admin access

- Add a dedicated `support-email` section key to `constants/adminSectionKeys.js` and the frontend `adminSectionAccess.js`.
- Mount admin routes with `requireAdmin` and `requireAdminSection('support-email', ...)`.
- Do not rely on frontend navigation hiding for authorization.
- Audit every read of a full email body, every attachment download, every export, every reclassification, and every ticket mutation.
- Rate-limit exports and searches.
- Consider a stricter permission (`support-email-pii`) if support agents should see tickets but not full email bodies.
- Never expose an unauthenticated ticket or attachment endpoint.

### 11.7 Sensitive logging

- Log identifiers, stage, status, durations, and error codes.
- Do **not** log email bodies, subjects, sender/recipient addresses, phone numbers, attachment names, AI prompts, AI raw responses, tokens, `clientState`, or attachment bytes.
- Use a hash or last-4 representation where correlation is needed.
- Reuse `redactSensitiveText` and the key-based filtering idea from `chatbotStructuredLog`, but add email-specific fields explicitly rather than dumping arbitrary objects.
- Store AI raw responses only in a restricted collection, bounded in size, with the same retention as the email.
- Ensure error middleware never echoes raw provider responses.

### 11.8 Data retention and privacy

India’s Digital Personal Data Protection Act, 2023 and the organization’s own policies apply to student names, phone numbers, email addresses, marksheets, identity documents, and admission details.

**UNRESOLVED — requires legal/business input:**

| Data class | Suggested starting point | Notes |
|---|---|---|
| Raw email body + HTML | 90 days | Ticket keeps extracted facts |
| Raw attachments | 90 days | Extracted text may be kept longer |
| Extracted attachment text | 180 days | Restricted access |
| Tickets and student facts | 2–3 years | Align with CRM retention |
| AI runs (raw response) | 30–90 days | PII-bearing; restrict |
| Audit logs | 1–2 years | Access and mutation evidence |
| Processing job rows | 30 days after completion | Operational only |

Also decide:

- Whether the LLM provider may retain or train on data. A zero-retention/DPA commitment is required before sending PII.
- Data residency: Atlas region, Vercel function region, and provider region.
- Whether identity documents should be redacted before AI processing.
- Who can fulfill a deletion request and how deletion propagates to Sheets (projection) and backups.

### 11.9 Duplicate processing and incorrect classification

**Duplicates:** unique indexes on `graphMessageId` and `internetMessageId`; deterministic job keys; claim tokens; idempotent stage transitions; content-duplicate flags rather than silent drops.

**Incorrect AI output:**

- Confidence threshold (for example, auto-accept ≥ 0.80; review below).
- Never auto-close or auto-resolve a ticket from AI output.
- Human override is recorded with before/after values and the admin ID.
- Taxonomy and prompt versions are stored on every ticket and AI run.
- A labeled evaluation set is maintained; precision/recall is reported before prompt/model changes.
- Monitor drift: category distribution, confidence distribution, override rate, and “other” rate.
- Allow reclassification of a ticket without creating a duplicate Sheets row.

### 11.10 Security acceptance tests (Phase 8)

1. Graph client contract: only `GET` on messages/attachments; no `PATCH` `isRead`; no delete/move/send calls.
2. Permission negative test: another mailbox returns 403.
3. Webhook: invalid `clientState` rejected; wrong `tenantId` rejected; replay does not duplicate.
4. Prompt injection corpus: no instruction following; schema still valid; flags raised.
5. Attachment fuzzing: malformed PDF/DOCX/XLSX, zip bomb, macro-enabled file, oversized file, mismatched magic bytes.
6. Admin authorization: 401 without token, 403 without section, no IDOR across tickets.
7. Log scan: no bodies, subjects, phone numbers, tokens, or attachment names in logs.
8. Retention job: deletes only the intended data and leaves audit evidence.
9. Duplicate stress: 10 concurrent deliveries of the same notification create one email and one ticket.
10. Secret scan: no credentials in the repository or build output.

---

## 12. Recommended architecture

### 12.1 Principles

1. **MongoDB is the system of record.** Sheets, dashboards, and AI outputs are projections.
2. **At-least-once processing with idempotent stages.** Never assume exactly-once.
3. **Fast webhook, slow worker.** The webhook only validates and enqueues; the cron worker calls Graph and AI.
4. **One durable queue, one state machine per stage.** No Redis/BullMQ at this volume.
5. **Read-only mailbox access.** No send, no mark-read, no move, no delete.
6. **Activation boundary is explicit and testable.**
7. **Every external call has a timeout, a retry policy, and an audit record.**
8. **PII is minimized, access-controlled, and retained deliberately.**

### 12.2 Component view

```text
Microsoft Graph
   |  change notification (small JSON)
   v
POST /webhook/graph  (public, no admin auth)
   |  validationToken -> 200 text/plain
   |  else: clientState + tenant check -> dedupe event -> enqueue -> 202
   v
MongoDB
   SupportEmailWebhookEvent (unique dedupe)
   SupportEmail (unique graphMessageId / internetMessageId)
   SupportEmailProcessingJob (unique emailId+stage, lease, attempts)
   EmailSyncCursor (deltaLink, activationAt)
   GraphSubscription (expiry, clientState hash, status)

Vercel Cron: GET /api/cron/process-support-email (secret)
   |
   +--> single-flight lock (SupportEmailRun)
   +--> renew subscriptions if due
   +--> delta reconcile (bounded pages)
   +--> drain queue within a 45 s budget
   |      |
   |      +--> Stage FETCH: Graph message + attachments metadata
   |      +--> Stage ATTACHMENTS: download -> validate -> store -> extract text
   |      +--> Stage AI: classify + extract (JSON validated)
   |      +--> Stage TICKET: upsert ticket, link email, audit
   |      +--> Stage SHEETS: enqueue/flush Google Sheets outbox
   |
   +--> flush Sheets outbox (batched)
   +--> recovery: stale leases, dead-letter requeue policy, metrics

Admin SPA (/admin/support-email)
   |
   v
/api/admin/support-email/*  (requireAdmin + requireAdminSection)
```

### 12.3 Data model (proposed, not created)

| Collection | Purpose | Key fields | Key indexes |
|---|---|---|---|
| `SupportEmail` | One inbound message, immutable source fields | `graphMessageId`, `internetMessageId`, `conversationId`, `receivedDateTime`, `from`, `to`, `subject`, `bodyText`, `bodyHtmlSnippet`, `hasAttachments`, `activationAt`, `pipeline` | unique `graphMessageId`; unique partial `internetMessageId`; `{receivedDateTime:-1}`; `{conversationId:1, receivedDateTime:-1}`; `{pipeline.state:1, receivedDateTime:1}` |
| `SupportEmailAttachment` | Attachment metadata + extraction state | `emailId`, `graphAttachmentId`, `name`, `contentType`, `size`, `sha256`, `storageKey`, `isInline`, `scanStatus`, `extractStatus`, `extractedText`, `pageCount` | unique `{emailId, graphAttachmentId}`; `{emailId, isInline}`; `{sha256}` |
| `SupportEmailProcessingJob` | Durable queue | `emailId`, `stage`, `state`, `attempts`, `nextAttemptAt`, `leaseExpiresAt`, `claimToken`, `lastError`, `priority` | unique `{emailId, stage}`; `{state:1, nextAttemptAt:1, priority:-1}`; `{leaseExpiresAt:1}` |
| `SupportEmailAiRun` | Audit of each model call | `emailId`, `stage`, `model`, `promptKey`, `promptVersion`, `inputHash`, `rawResponse`, `parsed`, `confidence`, `usage`, `latencyMs`, `outcome` | `{emailId:1, createdAt:-1}`; unique `{inputHash:1, promptVersion:1, stage:1}` (optional) |
| `SupportTicket` | Ticket state | `ticketNumber`, `emailIds`, `requester`, `student`, `enquiry`, `category`, `subCategory`, `priority`, `sentiment`, `confidence`, `status`, `assignedTo`, `dedupeKey`, `taxonomyVersion`, `aiRunId` | unique `ticketNumber`; unique `dedupeKey`; `{status:1, createdAt:-1}`; `{assignedTo:1, status:1}`; `{category:1, createdAt:-1}` |
| `SupportTicketEvent` | Append-only timeline | `ticketId`, `type`, `actorType`, `actorId`, `before`, `after`, `metadata` | `{ticketId:1, createdAt:-1}`; `{type:1, createdAt:-1}` |
| `SupportEmailAuditLog` | Security/audit | `adminId`, `action`, `targetType`, `targetId`, `ip`, `metadata` | `{createdAt:-1}`; `{action:1, createdAt:-1}`; `{targetId:1, createdAt:-1}` |
| `SupportEmailWebhookEvent` | Raw notification dedupe | `subscriptionId`, `resource`, `changeType`, `tenantId`, `dedupeKey`, `receivedAt`, `status` | unique `dedupeKey`; `{receivedAt:-1}` |
| `EmailSyncCursor` | Delta state | `mailbox`, `folder`, `deltaLink`, `lastSuccessfulSyncAt`, `activationAt`, `baselineCompletedAt` | unique `{mailbox:1, folder:1}` |
| `GraphSubscription` | Subscription state | `subscriptionId`, `resource`, `expirationDateTime`, `clientStateHash`, `status`, `lastRenewedAt` | unique `subscriptionId`; `{expirationDateTime:1}` |
| `GoogleSheetsSyncJob` | Outbox | `ticketId`, `spreadsheetId`, `tab`, `rowHash`, `state`, `attempts`, `nextAttemptAt`, `leaseExpiresAt`, `rowNumber`, `lastError` | unique `{ticketId, spreadsheetId, tab}`; `{state:1, nextAttemptAt:1}` |
| `SupportEmailRun` | Cron ledger | `runKey`, `startedAt`, `finishedAt`, `durationMs`, `success`, `stats`, `errorSummary` | `{runKey:1, startedAt:-1}`; `{startedAt:-1}` |
| `EmailIngestionPolicy` | Activation boundary | `mailbox`, `activationAt`, `baselineCompletedAt`, `enabled` | unique `mailbox` |

**Document size discipline:** store normalized text and a bounded HTML snippet. Never store raw MIME, full attachments, or unbounded HTML in `SupportEmail`.

### 12.4 State machines

**Email pipeline (independent stage statuses preferred over one giant enum):**

```text
ingest:      pending -> fetched -> failed(dead_letter)
attachments: pending -> processing -> extracted -> partial -> failed(dead_letter)
ai:          pending -> processing -> classified -> needs_review -> failed(dead_letter)
ticket:      pending -> linked -> created -> merged -> failed(dead_letter)
sheets:      pending -> synced -> failed -> exhausted
```

Derived overall status for the admin UI: `received`, `processing`, `needs_review`, `completed`, `failed`.

**Job states:** `pending` → `claimed` → `processing` → `completed` | `failed` (retryable) | `dead_letter` | `cancelled`.

Transitions are guarded by `claimToken` and current state. A stale worker cannot overwrite a newer claim.

### 12.5 Processing sequence (happy path)

1. Graph sends a notification.
2. Webhook validates and inserts `SupportEmailWebhookEvent` (unique dedupe).
3. Webhook upserts `SupportEmail` with `graphMessageId` and `ingest: pending` (or enqueues a fetch job only).
4. Webhook returns 202.
5. Cron tick acquires the single-flight lock.
6. Worker claims a `FETCH` job, gets the message from Graph with `$select`, normalizes body text, applies the activation guard, and stores immutable fields.
7. Worker enqueues `ATTACHMENTS` if `hasAttachments`.
8. Attachment stage lists attachments, downloads allowed files, validates magic bytes and caps, stores in GridFS, extracts text, records per-file status.
9. AI stage builds a bounded prompt, calls the model, validates JSON, retries once on malformed output, stores an AI run, and sets confidence/flags.
10. Ticket stage upserts a ticket by deterministic dedupe key, links the email, appends a timeline event.
11. Sheets stage upserts the outbox row; a batched flusher appends it to the sheet and stores the row number.
12. All stages `completed`; the email appears in the admin dashboard.

Latency expectation: webhook < 1 second; end-to-end typically 1–3 minutes, bounded by cron cadence and AI latency. This is acceptable for support email and should be stated as an SLO, not treated as real-time.

### 12.6 Failure and recovery matrix

| Stage | Retryable? | Backoff | Max attempts | Dead-letter behavior |
|---|---|---|---|---|
| Webhook enqueue | Yes (return 503) | Graph retries | N/A | Alert if repeated |
| Graph fetch | Yes (429/5xx/timeout) | `Retry-After`, then exponential + jitter | 6 | Dead-letter + admin requeue |
| Attachment download | Yes | Exponential | 5 per file | Mark file failed; ticket can continue with partial content |
| Attachment parse | Sometimes | Exponential for transient; no retry for unsupported/corrupt | 3 | Mark file failed; flag ticket |
| AI call | Yes (429/5xx/timeout) | Exponential + jitter | 4 | Mark `needs_review`; do not guess |
| JSON validation | Yes (one repair) | Immediate repair prompt | 2 | `needs_review` / `other` |
| Ticket upsert | Yes (duplicate key is success) | Immediate | 5 | Dead-letter |
| Sheets append | Yes | Exponential, cap 64 s | 5 | `exhausted` + dashboard alert; ticket remains valid |
| Delta sync | Yes | Next tick; 410 re-baseline | N/A | Alert if lag > 15 min |

### 12.7 Proposed module layout (Phase 1+)

```text
constants/supportEmail.js
config/graph.js
models/SupportEmail.js
models/SupportEmailAttachment.js
models/SupportEmailProcessingJob.js
models/SupportEmailAiRun.js
models/SupportTicket.js
models/SupportTicketEvent.js
models/SupportEmailAuditLog.js
models/SupportEmailWebhookEvent.js
models/EmailSyncCursor.js
models/GraphSubscription.js
models/GoogleSheetsSyncJob.js
models/SupportEmailRun.js
models/EmailIngestionPolicy.js

services/supportEmail/graphAuth.js
services/supportEmail/graphClient.js
services/supportEmail/webhookService.js
services/supportEmail/subscriptionService.js
services/supportEmail/deltaSyncService.js
services/supportEmail/ingestionService.js
services/supportEmail/attachmentService.js
services/supportEmail/attachmentValidation.js
services/supportEmail/extraction/pdfExtractor.js
services/supportEmail/extraction/docxExtractor.js
services/supportEmail/extraction/xlsxExtractor.js
services/supportEmail/extraction/imageExtractor.js
services/supportEmail/queueService.js
services/supportEmail/pipelineService.js
services/supportEmail/activationPolicy.js
services/supportEmail/dedupeService.js
services/supportEmail/classificationService.js
services/supportEmail/classificationSchema.js
services/supportEmail/promptGuard.js
services/supportEmail/prompts/emailClassification.v1.js
services/supportEmail/ticketService.js
services/supportEmail/ticketNumberService.js
services/supportEmail/sheetsSyncService.js
services/supportEmail/auditService.js
services/supportEmail/metricsService.js

controllers/supportEmailWebhookController.js
controllers/supportEmailAdminController.js
routes/supportEmailWebhookRoutes.js
routes/supportEmailAdminRoutes.js

scripts/ensureSupportEmailIndexes.js
scripts/supportEmailHealth.js
```

This mirrors the existing route/controller/service/model split and keeps the email module isolated from chatbot, CRM, and WhatsApp code.

### 12.8 Environment contract (names only, no values)

```text
# Microsoft Graph
GRAPH_TENANT_ID=
GRAPH_CLIENT_ID=
GRAPH_CLIENT_CERTIFICATE_BASE64=
GRAPH_CLIENT_CERTIFICATE_PASSWORD=
# or GRAPH_CLIENT_SECRET= (less preferred)
GRAPH_SUPPORT_MAILBOX=support@niatindia.com
GRAPH_WEBHOOK_CLIENT_STATE=
GRAPH_WEBHOOK_URL=
GRAPH_LIFECYCLE_URL=
GRAPH_ACTIVATION_AT=

# Processing
SUPPORT_EMAIL_BATCH_SIZE=25
SUPPORT_EMAIL_TIME_BUDGET_MS=45000
SUPPORT_EMAIL_STALE_LEASE_MS=120000
SUPPORT_EMAIL_MAX_ATTACHMENT_BYTES=10485760
SUPPORT_EMAIL_MAX_MESSAGE_ATTACHMENT_BYTES=26214400
SUPPORT_EMAIL_MAX_PDF_PAGES=30

# AI
SUPPORT_EMAIL_LLM_MODEL=
SUPPORT_EMAIL_LLM_MAX_TOKENS=
SUPPORT_EMAIL_LLM_TIMEOUT_MS=
SUPPORT_EMAIL_CONFIDENCE_THRESHOLD=0.80

# Google Sheets (dedicated, not GOOGLE_SHEET_ID)
SUPPORT_EMAIL_SHEET_ID=
SUPPORT_EMAIL_SHEET_TAB=
```

Reuse `GOOGLE_SHEETS_CREDENTIALS_JSON` for authentication.

### 12.9 Alternatives considered

| Option | Verdict | Reason |
|---|---|---|
| Redis + BullMQ | **Not justified** | Adds a second state store, a worker process, and ops burden. Mongo lease queue already proven at this scale. |
| Vercel Queues / Workflows | **Defer** | First-party and viable, but new platform surface and cost model. Re-evaluate if cron batching cannot meet latency/backlog SLOs. |
| Separate always-on worker | **Defer** | Justified only by measured CPU/memory/latency contention. Keep the module portable so it can move. |
| Graph webhook only | **Insufficient** | Missed notifications and expired subscriptions cause permanent gaps. Delta is mandatory. |
| Delta polling only | **Insufficient** | Higher latency and unnecessary API load; webhook gives near-real-time ingestion. |
| Application Access Policy only | **Obsolete / Rejected** | Legacy mechanism. Deprecated by Microsoft and forbidden for GuideXpert. Exchange Online RBAC for Applications is mandatory. |
| GridFS storage | **Default** | Zero new infrastructure and already used. Revisit on measured cost/size. |
| Vercel Blob / S3 | **Contingent** | Better for large binaries and lifecycle policies, but new infrastructure and credentials. |

---

## 13. Development roadmap

### Phase 0 — Repository audit and architecture validation

**Deliverables**
- This document.
- Confirmed reusable components, risks, decisions, and Phase 1 scope.
- No code changes.

**Dependencies**
- Access to the repository and the Phase 0 brief.

**Risks**
- Audit drift if the working tree changes during review.

**Acceptance criteria**
- All required sections present.
- Every claimed file path verified.
- Verified facts distinguished from estimates and recommendations.
- PASS/FAIL verdict with explicit blockers.
- No application code, dependency, or configuration changed.

---

### Phase 1 — Database models and processing foundation

**Deliverables**
- `constants/supportEmail.js` with enums and stage names.
- Models listed in §12.3, with indexes declared and no side effects.
- `services/supportEmail/queueService.js`: enqueue, atomic claim, lease renewal, release, retry with backoff, dead-letter, stale recovery.
- `services/supportEmail/stateMachine.js`: guarded transitions.
- `services/supportEmail/dedupeService.js`: deterministic keys and duplicate handling.
- `services/supportEmail/ticketNumberService.js`: atomic counter.
- `scripts/ensureSupportEmailIndexes.js`: dry-run by default, duplicate preflight, refuses non-local/production.
- `docs/support-email-automation/PHASE_1_MODELS.md`: collections, indexes, state machines, runbook.
- Tests: queue concurrency, crash recovery, dedupe, state guards, index script preflight.

**Dependencies**
- Phase 0 approval.
- Atlas tier/storage check (for awareness; no index changes yet).
- Decision on storage abstraction (GridFS default).

**Risks**
- Index drift because remote `autoIndex` is off.
- Over-modeling before real data exists.
- Accidental coupling to WhatsApp models.

**Acceptance criteria**
- No Graph, AI, Sheets, or route/cron changes.
- All new models load without creating indexes on a remote database.
- Four concurrent workers claim 100 jobs exactly once each.
- A simulated crash after claim is recovered after lease expiry.
- Retry attempts cap and move to `dead_letter`.
- Duplicate `graphMessageId` / `internetMessageId` inserts are rejected by unique indexes.
- Partial unique indexes work when optional keys are null.
- Index script dry-run lists planned indexes and refuses a non-local URI.
- `npm test` (or the targeted test command) passes.

---

### Phase 2 — Microsoft Graph integration

**Deliverables**
- `graphAuth.js` (certificate/secret, token cache, refresh).
- `graphClient.js` (GET-only message/attachment calls, 429/5xx handling, timeouts).
- `subscriptionService.js` (create, renew, lifecycle handling).
- `webhookService.js` + `supportEmailWebhookController.js` + route.
- `deltaSyncService.js` + `EmailSyncCursor`.
- `activationPolicy.js` and the per-message historical guard.
- `ingestionService.js`: normalize message fields, dedupe, enqueue.
- `scripts/supportEmailHealth.js`: mailbox reachability, subscription status, cursor status, negative permission test.
- Docs: deployment and Graph runbook (no secrets).

**Dependencies**
- Phase 1.
- Credential created and stored in Vercel.
- Exchange Online RBAC for Applications enforced and verified with Test-ServicePrincipalAuthorization.
- Public webhook URL reachable without Vercel authentication.
- Test mailbox or controlled production activation window.

**Risks**
- Permission propagation delay (30 min–2 h).
- Webhook blocked by Deployment Protection.
- Cold-start validation timeout.
- Shared-mailbox path/permission surprises.
- Delta baseline accidentally importing history.

**Acceptance criteria**
- Validation handshake returns `text/plain` in under 10 seconds from cold start.
- Notification POST returns 202 in under 1 second under test.
- Invalid `clientState` and wrong `tenantId` are rejected.
- Duplicate notifications produce one email row.
- Pre-activation messages are not imported; one skip audit is recorded.
- Another mailbox returns 403.
- No `PATCH`, delete, move, or send requests exist in the client (contract test).
- Subscription renews before expiry; lifecycle events are handled.
- Delta `410` re-baselines without historical import.
- 429 honors `Retry-After`.

---

### Phase 3 — Attachment processing

**Deliverables**
- `attachmentService.js`: list, download, skip inline, caps, per-file state.
- `attachmentValidation.js`: MIME allowlist, magic bytes, size/entry/page caps, macro rejection.
- Extractors: PDF text, DOCX text, XLSX cell text, image OCR (or vision-model path).
- GridFS bucket `support_email_attachments` behind a storage abstraction.
- Authenticated admin download endpoint with short-lived token.
- Attachment retention/deletion job (configurable).
- Fixture corpus and fuzz tests.

**Dependencies**
- Phase 2.
- New parsing/OCR dependencies (not installed in Phase 0).
- Storage/retention decision.
- Virus-scanning posture confirmed.

**Risks**
- Serverless bundling/worker issues for PDF libraries.
- Memory/CPU limits on large PDFs or OCR.
- Malicious or malformed files.
- Atlas storage growth.
- OCR accuracy and language coverage.

**Acceptance criteria**
- Only allowed types are stored; macro-enabled, HTML, SVG, archive, and executable files are rejected.
- Magic-byte mismatch is rejected even when the extension lies.
- Zip-bomb and oversized-file tests fail safely.
- A corrupt PDF/DOCX/XLSX does not crash the worker; the file is marked failed and the ticket continues.
- Extracted text is bounded and stored separately from the binary.
- Attachment download requires admin auth and the section key; no public URL exists.
- Retention job deletes only expired binaries and leaves audit metadata.
- Measured p95 memory stays within the function limit.

---

### Phase 4 — AI classification and extraction

**Deliverables**
- Email classification prompt v1 with explicit injection defenses.
- JSON schema validator + one repair retry.
- `classificationService.js`: input budgeting, call, validation, confidence, flags, AI-run audit.
- Taxonomy constants and versioning.
- Low-confidence review routing.
- Evaluation set (labeled emails) and an offline evaluation script.
- Cost/latency metrics per run.
- Prompt-injection regression tests.

**Dependencies**
- Phases 1–3.
- Provider/model capability spike (JSON mode, context window, vision, rate limits).
- DPA/zero-retention confirmation.
- Agreed taxonomy and confidence threshold.

**Risks**
- Model ignores JSON constraints.
- Provider rate limits at peak.
- PII exposure to the provider.
- Misclassification of multilingual emails.
- Cost overrun.
- Prompt injection success.

**Acceptance criteria**
- ≥ 98% of calls yield schema-valid JSON after at most one repair (target; measure).
- Invalid enum/phone/email values never reach a ticket unvalidated.
- A known injection corpus cannot change the schema, trigger an action, or reveal the prompt.
- Low-confidence results route to `needs_review`; no auto-close.
- Every AI call has an audit row with model, prompt version, usage, latency, and outcome.
- Token/cost budget per day is enforced or alerted.
- Evaluation precision/recall meets the agreed threshold per category.

---

### Phase 5 — Ticket management

**Deliverables**
- `ticketService.js`: deterministic upsert, threading by `conversationId`, merge, assignment, status transitions.
- Student/enquiry linkage rules (exact match only; unverified otherwise).
- Ticket number generator.
- Append-only ticket timeline.
- Duplicate detection and manual merge.
- Admin-independent tests for concurrency and idempotency.

**Dependencies**
- Phase 4.
- Agreed ticket statuses, categories, assignment rules, and SLA fields.
- Decision on whether replies create new tickets or append to an existing thread.

**Risks**
- Duplicate tickets from retries.
- Wrong student linkage.
- Status machine dead ends.
- Merge data loss.

**Acceptance criteria**
- One new enquiry creates exactly one ticket under concurrent retries.
- A reply in the same conversation appends to the existing ticket (per agreed policy).
- Merge preserves both source emails and writes an audit event.
- Invalid status transitions are rejected.
- No automatic closure or resolution from AI output.
- Student linkage is exact-match only; ambiguous matches are flagged.

---

### Phase 6 — Google Sheets synchronization

**Deliverables**
- `sheetsSyncService.js`: outbox, batched append, row-number tracking, retry, reconciliation.
- Dedicated spreadsheet/tab configuration.
- Header schema and column mapping.
- Sync status in the admin API.
- Backfill/repair script for tickets missing an outbox row.
- Quota-aware batching.

**Dependencies**
- Phase 5.
- New spreadsheet created and shared with the service account.
- Agreed column schema and update semantics.

**Risks**
- Duplicate rows on ambiguous timeout.
- Quota bursts.
- Schema drift in the sheet.
- Service-account permission loss.

**Acceptance criteria**
- Every completed ticket appears exactly once.
- A simulated 429 and 500 retries successfully without duplicates.
- A timeout-after-append is reconciled by a bounded read, not a blind append.
- Batch size stays within quota; no more than 60 writes/minute.
- Ticket creation succeeds even when Sheets is unavailable.
- The forms sheet (`GOOGLE_SHEET_ID`) is never written by this module.

---

### Phase 7 — Admin APIs and dashboard

**Deliverables**
- `support-email` section key in backend and frontend.
- Admin routes: list/search emails, email detail, attachments, tickets, assignment, status, reclassify, requeue, export, metrics/health.
- React admin pages under `/admin/support-email` using the existing `AdminLayout`.
- Attachment download with a short-lived token.
- Audit logging for reads, exports, and mutations.
- Pagination and filters consistent with existing admin APIs.

**Dependencies**
- Phases 5–6.
- Agreed UI scope and roles.
- Frontend build and lint pass.

**Risks**
- PII overexposure in list endpoints.
- IDOR.
- Large exports.
- UI scope creep.

**Acceptance criteria**
- 401 without a token, 403 without the section key.
- No cross-ticket IDOR.
- List endpoints omit bodies and attachment contents.
- Detail/download/export actions are audited.
- Reclassify and requeue are idempotent and audited.
- Frontend lint and build pass.
- Dashboard shows queue depth, oldest pending age, failures, delta lag, and subscription expiry.

---

### Phase 8 — Reliability and security testing

**Deliverables**
- Load test at 2,000/day average and 60/minute burst (synthetic fixtures).
- Crash/timeout/duplicate injection across every stage.
- Attachment fuzzing and prompt-injection corpus.
- Permission negative tests.
- Log/PII scan.
- Retention job tests.
- Dependency audit and secret scan.
- Runbooks: incident, replay, dead-letter, subscription loss, credential rotation.
- SLO definitions and alert thresholds.

**Dependencies**
- Phases 1–7.
- Staging environment and test mailbox.
- Security/legal review of retention and provider data handling.

**Risks**
- Test data leaking into production.
- Unrealistic load fixtures.
- False confidence from mocks.

**Acceptance criteria**
- No duplicate ticket under 10 concurrent deliveries of the same notification.
- Crash at every stage recovers without manual intervention or data loss.
- p95 end-to-end processing within the agreed SLO at design peak.
- No secrets in repo or logs.
- No unauthorized mailbox access.
- Retention job verified.
- Rollback and replay runbooks executed successfully.

---

### Phase 9 — Production rollout

**Deliverables**
- Production credential and scoped permission verification.
- Subscription created; activation timestamp recorded.
- Shadow mode (read + classify, no tickets) for a defined period.
- Canary enablement for a subset or a controlled window.
- Monitoring dashboards and alerts.
- Operations handover: support workflow, requeue, review queue, escalation.
- Rollback plan.

**Dependencies**
- Phase 8 sign-off.
- Business approval of taxonomy, retention, and support workflow.
- Exchange/admin availability for permission changes.

**Risks**
- Historical import at activation.
- Permission propagation delay.
- Unexpected volume.
- Support-team process gaps.

**Acceptance criteria**
- No email received before `activationAt` is imported.
- Exactly one ticket per new email during the canary.
- Subscription remains active for 7 consecutive days.
- Error rate and backlog within SLO.
- Rollback tested: disable ingestion without losing queued work.
- Business sign-off.

---

## 14. Risks and unresolved decisions

### 14.1 Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Phase |
|---|---|---|---|---|---|
| R1 | Tenant-wide `Mail.Read` violates least privilege | High (current) | Critical | Exchange RBAC scoping; remove unscoped grant; negative test | 2 |
| R2 | Historical emails imported at activation | Medium | High | Activation policy + filtered baseline + per-message guard + tests | 2 |
| R3 | Webhook unreachable due to Vercel protection | Medium | High | Verify settings; allow `/webhook/graph`; test from external network | 2 |
| R4 | Cold-start validation exceeds 10 s | Medium | High | Narrow DB bypass for validation; keep function warm if needed | 2 |
| R5 | Attachment storage cost/size | Medium | High | Measure distribution; caps; retention; GridFS vs Blob decision | 3 |
| R6 | Attachment parsing OOM/timeout | Medium | High | Size/page caps; stream where possible; separate function if needed | 3 |
| R7 | AI schema non-compliance | High initially | Medium | Validator + repair retry; provider spike; fallback model | 4 |
| R8 | AI provider rate limits at peak | Medium | High | Queue smoothing; concurrency caps; backoff; provider quota check | 4 |
| R9 | Prompt injection changes behavior | High | High | Data-only prompt; no tools; schema validation; injection corpus | 4 |
| R10 | PII sent to a provider that retains data | Unknown | High | DPA/zero-retention confirmation; redaction; legal review | 4 |
| R11 | Duplicate tickets | High without design | Medium | Unique keys + idempotent stages + claim tokens | 1/5 |
| R12 | Sheets duplicates after timeout | Medium | Medium | Row-number tracking + bounded read reconciliation | 6 |
| R13 | Index never created in production | Medium | High | Dry-run script + runbook + verification query | 1 |
| R14 | Cron overlap double-processes work | Medium | Medium | Single-flight lease lock + claim tokens | 1 |
| R15 | Retention/deletion obligations unmet | Medium | High | Retention policy + deletion jobs + audit | 8 |
| R16 | Model/taxonomy drift degrades accuracy | Medium | Medium | Evaluation set + override monitoring + version pinning | 8 |
| R17 | Atlas tier insufficient for attachments | Unknown | Medium | Measure; upgrade or externalize binaries | 3 |
| R18 | Function memory contention with user traffic | Low–Medium | Medium | Bounded batches; monitor; split function if needed | 8 |

### 14.2 Decision log

| ID | Decision | Options | Recommendation | Owner | Needed by |
|---|---|---|---|---|---|
| D1 | Mailbox scoping model | Exchange Online RBAC for Applications | Exchange RBAC + remove unscoped Entra grant | Exchange admin + Security | Before Phase 2 |
| D2 | Credential type | Client secret / certificate | Certificate | Security + Backend | Before Phase 2 |
| D3 | Webhook exposure | Deployment Protection with bypass / public path | Explicit bypass for `/webhook/graph`, all else protected | DevOps | Before Phase 2 |
| D4 | Attachment storage | GridFS / Vercel Blob / S3 | GridFS first, measure, then decide | Backend + DevOps | Phase 3 |
| D5 | Attachment retention | 30 / 90 / 180 days | 90 days for binaries, longer for extracted text | Business + Legal | Phase 3 |
| D6 | OCR | Local OCR / vision model / none | Vision model if provider supports; otherwise local OCR | AI + Backend | Phase 3 |
| D7 | AI provider/model | Current LLM endpoint / dedicated endpoint | Dedicated email prompt, same provider unless limits require otherwise | AI | Phase 4 |
| D8 | Provider data handling | Standard terms / zero-retention DPA | Zero-retention DPA | Legal + Security | Phase 4 |
| D9 | Ticket taxonomy | Agreed list | Start with 8–10 categories; version it | Support + Product | Phase 4 |
| D10 | Confidence threshold | 0.7 / 0.8 / 0.9 | 0.80 auto-accept; below routes to review | Support + AI | Phase 4 |
| D11 | Reply handling | New ticket per email / append by conversation | Append by `conversationId`; new ticket only for a new enquiry | Support + Product | Phase 5 |
| D12 | Sheets schema | Minimal / full | Minimal operational columns + ticket ID as the key | Support + Reporting | Phase 6 |
| D13 | Admin roles | One section key / split PII vs ticket | Start with one; split if support agents should not see bodies | Security + Product | Phase 7 |
| D14 | Retention overall | Various | Legal review; separate classes | Legal | Phase 8 |

---

## 15. Phase 1 checklist

Phase 1 is **models and processing foundation only**. It must be possible to complete it with no Microsoft Graph account, no AI calls, and no Google Sheets access.

### 15.1 Deliverables checklist

- [ ] `constants/supportEmail.js` — stages, job states, pipeline statuses, attachment statuses, category enums, limits.
- [ ] Models: `SupportEmail`, `SupportEmailAttachment`, `SupportEmailProcessingJob`, `SupportEmailAiRun`, `SupportTicket`, `SupportTicketEvent`, `SupportEmailAuditLog`, `SupportEmailWebhookEvent`, `EmailSyncCursor`, `GraphSubscription`, `GoogleSheetsSyncJob`, `SupportEmailRun`, `EmailIngestionPolicy`.
- [ ] `services/supportEmail/queueService.js` — enqueue, claim, renew, release, retry, dead-letter, stale recovery.
- [ ] `services/supportEmail/stateMachine.js` — guarded transitions.
- [ ] `services/supportEmail/dedupeService.js` — normalized keys and duplicate classification.
- [ ] `services/supportEmail/ticketNumberService.js` — atomic per-day or global counter.
- [ ] `scripts/ensureSupportEmailIndexes.js` — dry-run default, duplicate preflight, local-only guard.
- [ ] `docs/support-email-automation/PHASE_1_MODELS.md` — collection/index/state tables and index runbook.
- [ ] Tests:
  - [ ] Queue claim is exclusive under 4 concurrent workers.
  - [ ] Crash after claim recovers after lease expiry.
  - [ ] Attempts cap and dead-letter.
  - [ ] Duplicate email keys are rejected.
  - [ ] Partial unique indexes handle nulls.
  - [ ] Invalid state transitions are rejected.
  - [ ] Ticket number generation is atomic.
  - [ ] Index script refuses non-local and prints a dry-run plan.
  - [ ] No Graph/AI/Sheets network calls occur in tests.

### 15.2 Explicit non-goals for Phase 1

- No Microsoft Graph client, token, subscription, webhook, or delta code.
- No AI prompt or provider call.
- No Google Sheets sync.
- No ticket API routes.
- No admin UI.
- No `server.js` route mounts.
- No `vercel.json` changes.
- No cron changes.
- No changes to chatbot, CRM, WhatsApp, forms, or answer-studio code.
- No dependency installation.

### 15.3 Pre-flight questions for Phase 1

1. Is the Atlas cluster tier known, and is there headroom for 25–120 GB/month of attachments if GridFS is used?
2. Is the retention policy for raw email, attachments, tickets, AI runs, and audit logs agreed?
3. Is the production LLM model known well enough to size prompts/tokens, or is a Phase 4 spike sufficient?
4. Does the team want a single `support-email` admin section key or a split PII/ticket role?
5. Is `support@niatindia.com` the Graph `userPrincipalName`, the primary SMTP address, or an alias? Graph accepts the user ID or UPN; confirm the exact path value before Phase 2.

### 15.4 Definition of done

- All Phase 1 tests pass locally against an in-memory MongoDB.
- `git diff` contains only the intended additive files.
- No existing module behavior changes.
- The index script has been dry-run against a local database and its output is attached to the Phase 1 report.
- The Phase 1 report documents every collection, index, state transition, and failure path.
- A reviewer can explain how a job is claimed, retried, recovered, and dead-lettered without reading the code.

---

## 16. Phase 0 verdict

### 16.1 Verdict

**PASS.**

The repository is a sound foundation for the support-email system. The backend, MongoDB patterns, AI transport, Google Sheets client, admin authorization, GridFS storage, and test harness are all reusable. There is no conflicting email implementation and no architectural obstacle that requires Redis, BullMQ, or a separate worker at the stated volume.

### 16.2 Conditions

Phase 0 passes with the following conditions:

1. **Phase 1 may proceed** with models, queue, state machines, indexes, and tests only. It must not touch Graph, AI, Sheets, routes, crons, or Vercel config.
2. **Phase 2 must not start** until the mailbox is scoped to `support@niatindia.com`, the credential exists in Vercel, the webhook is publicly reachable, and a test activation has been rehearsed.
3. **The tenant-wide `Mail.Read` grant is a release blocker.** It contradicts the business restriction and must be replaced by the scoped model described in §10.3.
4. **Attachment storage and retention are unresolved.** GridFS is the default, but the decision must be validated with measured volume in Phase 3.
5. **The LLM provider’s data handling, rate limits, and structured-output capability are unresolved.** These must be confirmed before Phase 4 processes real student PII.

### 16.3 What would turn this into a FAIL

- The tenant refuses to scope mailbox access and insists on tenant-wide `Mail.Read`.
- Vercel cannot expose an unauthenticated webhook path.
- The business requires historical email import.
- The business requires automatic replies or mailbox mutation.
- Attachment volume is incompatible with the available Atlas tier and no external storage is permitted.
- The AI provider cannot meet the required privacy or structured-output constraints.

None of these are true today based on the information available. They are the questions to settle before Phase 2.

---

## Appendix A — Proposed index plan (Phase 1)

**Do not create these indexes in Phase 0.** They are a design proposal for the Phase 1 migration script.

| Collection | Index | Type | Notes |
|---|---|---|---|
| `supportEmails` | `{ graphMessageId: 1 }` | unique | Primary Graph identity |
| `supportEmails` | `{ internetMessageId: 1 }` | unique partial (`$type: 'string', $ne: ''`) | Secondary dedupe |
| `supportEmails` | `{ receivedDateTime: -1 }` | normal | List/search |
| `supportEmails` | `{ conversationId: 1, receivedDateTime: -1 }` | compound | Threading |
| `supportEmails` | `{ 'pipeline.state': 1, receivedDateTime: 1 }` | compound | Work scans |
| `supportEmailAttachments` | `{ emailId: 1, graphAttachmentId: 1 }` | unique | Idempotent attachment rows |
| `supportEmailAttachments` | `{ emailId: 1, isInline: 1 }` | compound | Filter signatures |
| `supportEmailAttachments` | `{ sha256: 1 }` | normal | Binary dedupe/correlation |
| `supportEmailProcessingJobs` | `{ emailId: 1, stage: 1 }` | unique | One job per stage |
| `supportEmailProcessingJobs` | `{ state: 1, nextAttemptAt: 1, priority: -1 }` | compound | Claim scan |
| `supportEmailProcessingJobs` | `{ leaseExpiresAt: 1 }` | normal | Stale recovery |
| `supportEmailAiRuns` | `{ emailId: 1, createdAt: -1 }` | compound | Audit list |
| `supportTickets` | `{ ticketNumber: 1 }` | unique | Human key |
| `supportTickets` | `{ dedupeKey: 1 }` | unique | Idempotent creation |
| `supportTickets` | `{ status: 1, createdAt: -1 }` | compound | List |
| `supportTickets` | `{ assignedTo: 1, status: 1 }` | compound | Workload |
| `supportTickets` | `{ category: 1, createdAt: -1 }` | compound | Reporting |
| `supportTicketEvents` | `{ ticketId: 1, createdAt: -1 }` | compound | Timeline |
| `supportEmailAuditLogs` | `{ createdAt: -1 }` | normal | Audit list |
| `supportEmailAuditLogs` | `{ action: 1, createdAt: -1 }` | compound | Audit filter |
| `supportEmailWebhookEvents` | `{ dedupeKey: 1 }` | unique | Notification dedupe |
| `supportEmailWebhookEvents` | `{ receivedAt: -1 }` | normal | Ops |
| `emailSyncCursors` | `{ mailbox: 1, folder: 1 }` | unique | One cursor per folder |
| `graphSubscriptions` | `{ subscriptionId: 1 }` | unique | Renewal lookup |
| `graphSubscriptions` | `{ expirationDateTime: 1 }` | normal | Renewal scan |
| `googleSheetsSyncJobs` | `{ ticketId: 1, spreadsheetId: 1, tab: 1 }` | unique | One projection per ticket |
| `googleSheetsSyncJobs` | `{ state: 1, nextAttemptAt: 1 }` | compound | Outbox scan |
| `supportEmailRuns` | `{ runKey: 1, startedAt: -1 }` | compound | Cron history |
| `emailIngestionPolicies` | `{ mailbox: 1 }` | unique | Activation boundary |

**Index migration rules:**

- Use `createIndexes`, not `syncIndexes`, for anything that could drop an index.
- Preflight duplicate counts before creating a unique index.
- Print created vs existing indexes.
- Refuse `NODE_ENV=production` and every non-local URI in the script; production creation is a separate, reviewed DBA step.
- Verify with `Model.collection.indexes()` after creation.

---

## Appendix B — Environment names (no values)

| Group | Names |
|---|---|
| Graph auth | `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_CERTIFICATE_BASE64`, `GRAPH_CLIENT_CERTIFICATE_PASSWORD`, optionally `GRAPH_CLIENT_SECRET` |
| Graph mailbox | `GRAPH_SUPPORT_MAILBOX`, `GRAPH_ACTIVATION_AT` |
| Graph webhook | `GRAPH_WEBHOOK_CLIENT_STATE`, `GRAPH_WEBHOOK_URL`, `GRAPH_LIFECYCLE_URL` |
| Processing | `SUPPORT_EMAIL_BATCH_SIZE`, `SUPPORT_EMAIL_TIME_BUDGET_MS`, `SUPPORT_EMAIL_STALE_LEASE_MS`, `SUPPORT_EMAIL_MAX_ATTACHMENT_BYTES`, `SUPPORT_EMAIL_MAX_MESSAGE_ATTACHMENT_BYTES`, `SUPPORT_EMAIL_MAX_PDF_PAGES` |
| AI | `SUPPORT_EMAIL_LLM_MODEL`, `SUPPORT_EMAIL_LLM_MAX_TOKENS`, `SUPPORT_EMAIL_LLM_TIMEOUT_MS`, `SUPPORT_EMAIL_CONFIDENCE_THRESHOLD`; existing `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES` |
| Sheets | existing `GOOGLE_SHEETS_CREDENTIALS_JSON`, new `SUPPORT_EMAIL_SHEET_ID`, `SUPPORT_EMAIL_SHEET_TAB` |
| Cron | existing `GUIDEXPERT_CRON_SECRET` / `CRON_SECRET` |
| Existing | `MONGODB_URI`, `ADMIN_JWT_SECRET` |

---

## Appendix C — Graph endpoint contract (read-only)

| Purpose | Method | Path | Notes |
|---|---|---|---|
| Verify token | POST | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` | Client credentials; cache token |
| List/delta messages | GET | `/users/{mailbox}/mailFolders/inbox/messages/delta` | `changeType=created`, `$select`, `$top` |
| Get message | GET | `/users/{mailbox}/messages/{id}` | Body + recipients |
| List attachments | GET | `/users/{mailbox}/messages/{id}/attachments` | Metadata only |
| Download attachment | GET | `/users/{mailbox}/messages/{id}/attachments/{attachmentId}/$value` | File bytes |
| Create subscription | POST | `/subscriptions` | `changeType: created`, expiry, `clientState`, lifecycle URL |
| Renew subscription | PATCH | `/subscriptions/{id}` | Extend `expirationDateTime` |
| Delete subscription | DELETE | `/subscriptions/{id}` | Deactivation only |
| Other mailbox (negative test) | GET | `/users/{other}/messages` | Must return 403 |

**Forbidden by design:**

- `PATCH /users/{mailbox}/messages/{id}` with `isRead` — never mark as read.
- Any delete or move of a message.
- `POST /users/{mailbox}/sendMail` or `/reply` — never send.
- Any write to attachments.
- Following `referenceAttachment` URLs outside the mailbox.

---

## Appendix D — Capacity worksheet

Use these formulas with measured data in Phase 3/4.

```text
emails_per_day            = measured
graph_calls_per_email     = 1 (message) + 0.3 (attachment list) + 0.39 (downloads)
                            + delta calls / emails
graph_calls_per_day       = emails_per_day * graph_calls_per_email * (1 + retry_rate)
graph_peak_per_minute     = peak_emails_per_minute * graph_calls_per_email
graph_limit_per_minute    = 1000            # 10,000 / 10 minutes
graph_concurrency_limit   = 4

ai_calls_per_day          = emails_per_day * (1 + ai_retry_rate)
ai_peak_concurrency       = ceil(peak_emails_per_minute * p95_latency_seconds / 60)

mongo_writes_per_day      = emails_per_day * writes_per_email
attachment_gb_per_month   = emails_per_day * pct_with_attachments
                            * files_per_email * avg_file_mb
                            * 30 / 1024

tokens_per_email          = body_tokens + attachment_tokens + prompt_tokens
daily_cost                = emails_per_day * (
                              tokens_per_email / 1e6 * input_price_per_million
                              + output_tokens_per_email / 1e6 * output_price_per_million
                            )
```

**Design targets to validate:**

- Graph peak usage < 30% of the 1,000/minute limit.
- Graph concurrency ≤ 4.
- AI peak concurrency ≤ 8 unless the provider confirms a higher limit.
- Mongo per-invocation concurrency < 10 (the pool size).
- Queue drain capacity ≥ 60 emails/minute.
- p95 end-to-end < 5 minutes at design peak.
- Oldest pending job < 10 minutes at normal volume.

---

## Appendix E — Test plan summary

| Layer | What to test | Tooling |
|---|---|---|
| Queue | Claim exclusivity, stale lease recovery, retry cap, dead-letter, priority | `node:test` + `MongoMemoryReplSet` |
| Dedupe | Unique `graphMessageId` / `internetMessageId`, duplicate notifications, content-duplicate flags | In-memory Mongo with indexes |
| State machines | Invalid transitions rejected; claim token mismatch ignored | Unit tests |
| Webhook | Validation handshake, clientState, tenantId, duplicate delivery, 202 latency | Supertest-style HTTP tests + fixtures |
| Delta | Pagination, deltaLink persistence, 410 re-baseline, historical guard | Mocked Graph client |
| Graph client | GET-only contract, 429 Retry-After, timeout, 401 refresh once | Mocked HTTP |
| Attachments | Magic bytes, macro rejection, zip bomb, size caps, corrupt files, OCR fallback | Fixture corpus + fuzz cases |
| AI | Schema validation, repair retry, injection corpus, confidence routing, budget | Mocked provider + labeled set |
| Tickets | Idempotent creation, threading, merge, assignment, status guards | Concurrency tests |
| Sheets | Batch append, 429/500 retry, timeout reconciliation, quota, forms-sheet isolation | Mocked Sheets API |
| Auth | 401/403, section gate, IDOR, export limits | HTTP tests |
| Recovery | Crash at each stage, cron overlap, subscription loss, delta gap | Crash hooks + fake clock |
| Security | Log scan, secret scan, permission negative test, retention | Static scan + integration |

---

## Appendix F — References

**Repository files**

- `GuideXpert-Backend/server.js`
- `GuideXpert-Backend/vercel.json`
- `GuideXpert-Backend/package.json`
- `GuideXpert-Backend/config/db.js`
- `GuideXpert-Backend/config/mongooseSafety.js`
- `GuideXpert-Backend/config/googleSheets.js`
- `GuideXpert-Backend/routes/cronRoutes.js`
- `GuideXpert-Backend/models/WhatsAppInboundMessage.js`
- `GuideXpert-Backend/models/WhatsAppWebhookEvent.js`
- `GuideXpert-Backend/models/WhatsAppReminderJob.js`
- `GuideXpert-Backend/models/MessagingCronRun.js`
- `GuideXpert-Backend/services/chatbot/whatsappInboundService.js`
- `GuideXpert-Backend/services/whatsappReminderJobDispatcher.js`
- `GuideXpert-Backend/services/ai/llmClient.js`
- `GuideXpert-Backend/services/ai/providers/OpenAiCompatibleProvider.js`
- `GuideXpert-Backend/services/answerStudio/promptResolver.js`
- `GuideXpert-Backend/utils/googleSheetsService.js`
- `GuideXpert-Backend/utils/sheetsService.js`
- `GuideXpert-Backend/services/resourceStorageService.js`
- `GuideXpert-Backend/middleware/requireAdmin.js`
- `GuideXpert-Backend/middleware/requireAdminSection.js`
- `GuideXpert-Backend/constants/adminSectionKeys.js`
- `GuideXpert-Backend/utils/mongoRetry.js`
- `GuideXpert-Backend/scripts/syncCrmIndexes.js`
- `GuideXpert-Frontend/vercel.json`
- `GuideXpert-Frontend/src/constants/adminSectionAccess.js`
- `GuideXpert-Frontend/src/components/Admin/AdminLayout.jsx`

**Vendor documentation**

1. Microsoft Graph change notifications overview — subscription limits and latency:
   https://learn.microsoft.com/en-us/graph/change-notifications-overview
2. Microsoft Graph delta query for messages:
   https://learn.microsoft.com/en-us/graph/delta-query-messages
3. Exchange Online RBAC for Applications:
   https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac
4. Microsoft Graph throttling guidance:
   https://learn.microsoft.com/en-us/graph/throttling
5. Microsoft Graph service-specific throttling limits (Outlook):
   https://learn.microsoft.com/en-us/graph/throttling-limits
6. Attachment resource type (size guidance):
   https://learn.microsoft.com/en-us/graph/api/resources/attachment
7. Vercel function maximum duration:
   https://vercel.com/docs/functions/configuring-functions/duration
8. Vercel Cron usage and pricing:
   https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing
9. Google Sheets API quotas:
   https://developers.google.com/workspace/sheets/api/limits

---

## Appendix G — Open questions for the business

1. What is the agreed ticket taxonomy and SLA per category?
2. Should a reply in the same email thread append to the existing ticket or create a new one?
3. Which fields must appear in Google Sheets, and who owns the sheet schema?
4. What is the retention period for email bodies, attachments, and student documents?
5. May student identity documents be sent to the AI provider, or must they be redacted first?
6. Who is allowed to see full email bodies versus ticket summaries?
7. What is the escalation path for `needs_review` and `dead_letter` items?
8. Is there an existing internal alert channel (Slack/email) for operational failures?
9. Is a formal DPIA/DPA required before processing student email at this volume?
10. What is the exact production activation date, and who signs off on the historical boundary?

---

*End of Phase 0 audit.*
