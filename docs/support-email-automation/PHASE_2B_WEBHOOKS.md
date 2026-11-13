# GuideXpert Support Email Automation — Phase 2B: Microsoft Graph Webhooks & Notifications

## Document Information
- **Document Version:** 1.0.0
- **Phase:** 2B — Microsoft Graph Webhooks & Notifications
- **Repository:** GuideXpert-Backend
- **Branch:** `feat/support-email-phase-2b-webhooks`
- **Baseline Commit:** `6b02d3a70a2039a0ef49a19694e3e783d12f13e1`
- **Status:** Complete & Verified

---

## 1. Webhook Architecture and End-to-End Flow

Microsoft Graph Webhooks provide asynchronous wake-up signals whenever email messages arrive or change in the configured Exchange Online mailbox. In GuideXpert's architecture:

> **Fundamental Principle:** Microsoft Graph webhooks are wake-up signals, **not** the source of truth. Notification payloads are never used to directly ingest email bodies, download attachments, or spawn support tickets. Instead, validated notifications trigger monotonic synchronization passes against the existing unfiltered delta sync engine implemented in Phase 2A.

```
                      Microsoft Graph / Exchange Online
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            │ [1] Webhook Handshake                             │ [2] Change Notification
            │ GET /api/support-email/webhooks/graph             │ POST /api/support-email/webhooks/graph
            │   ?validationToken=TOKEN                          │   Body: { value: [ ... ] }
            ▼                                                   ▼
┌───────────────────────┐                           ┌───────────────────────┐
│ server.js DB Gate     │                           │ server.js DB Gate     │
│ Bypass (Zero DB delay)│                           │ (Connects to MongoDB) │
└───────────┬───────────┘                           └───────────┬───────────┘
            │                                                   │
            ▼                                                   ▼
┌───────────────────────────────┐           ┌───────────────────────────────────────┐
│ supportEmailWebhookController │           │ supportEmailWebhookController         │
│ - Decode validationToken      │           │ - Constant-time clientState verify    │
│ - Return 200 text/plain       │           │ - Verify active GraphSubscription     │
│   within milliseconds         │           │ - Deduplicate (resourceData / bucket) │
└───────────────────────────────┘           │ - Persist SupportEmailWebhookEvent    │
                                            │ - signalMailboxSync()                 │
                                            │ - Return 202 Accepted immediately     │
                                            └───────────────────┬───────────────────┘
                                                                │
                                                                ▼
                                            ┌───────────────────────────────────────┐
                                            │ mailboxSyncService                    │
                                            │ - Atomic sync lock acquisition        │
                                            │ - Monotonic version increment         │
                                            │ - Coalesced delta sync pass           │
                                            └───────────────────┬───────────────────┘
                                                                │
                                                                ▼
                                            ┌───────────────────────────────────────┐
                                            │ deltaSyncService (Phase 2A)           │
                                            │ - Follow @odata.deltaLink             │
                                            │ - Normalize & dedupe via MsgId        │
                                            │ - Ingest idempotently into DB         │
                                            └───────────────────────────────────────┘
```

---

## 2. Validation Handshake Mechanics

When creating or renewing a subscription, Microsoft Graph issues an immediate synchronous HTTP request to the designated webhook endpoint before returning 201 Created to the caller:

- **HTTP Method:** `POST` or `GET` (Graph documents POST with query param, but some proxies convert or test GET)
- **Query Parameter:** `?validationToken=<token>`
- **Deadline:** Microsoft Graph requires an HTTP 200 response with the exact decoded token inside **10 seconds**, otherwise the subscription creation call immediately fails with `Invalid: Subscription validation request failed`.
- **Response Format:**
  - Status: `200 OK`
  - `Content-Type`: `text/plain; charset=utf-8`
  - Body: Plain text of the decoded validation token (no JSON wrapping, no quotes, no HTML).

### Database Gate Bypass (`shouldBypassDbGate`)
On Vercel serverless functions, database cold starts (connecting to MongoDB Atlas through SSL/TLS handshakes) can take between 2 to 6 seconds under heavy load. If incoming subscription validations were gated behind MongoDB connection establishment, cold starts could exceed Graph's strict 10s deadline.

In `server.js`, the database gate middleware explicitly inspects incoming requests:
```javascript
function shouldBypassDbGate(req) {
  if (req.path === '/api/health') return true;
  // Microsoft Graph subscription validation handshake must never be blocked by database connection
  if (req.path === '/api/support-email/webhooks/graph' && req.query && typeof req.query.validationToken !== 'undefined') {
    return true;
  }
  if (req.method !== 'GET') return false;
  return /^\/(?:api\/)?blogs(?:\/[^/]+)?\/?$/.test(req.path);
}
```
Validation handshake requests respond in **under 5 milliseconds**, completely independent of MongoDB state.

---

## 3. Notification Payload Structure

When changes occur, Microsoft Graph sends a POST request containing a JSON body with a `value` array:

```json
{
  "value": [
    {
      "subscriptionId": "7f093077-f48e-4377-af76-08088fcb0494",
      "subscriptionExpirationDateTime": "2026-11-16T18:23:45.935Z",
      "clientState": "7b8f9e012c4d5a6b7e8f...",
      "changeType": "created",
      "resource": "Users/support@guidexpert.com/Messages/AAMkAG...",
      "resourceData": {
        "@odata.type": "#Microsoft.Graph.Message",
        "@odata.id": "Users/support@guidexpert.com/Messages/AAMkAG...",
        "@odata.etag": "W/\"CQAAABY...\"",
        "id": "AAMkAG..."
      },
      "tenantId": "d16c5264-b81b-4d43-b91c-b5f7b8801d0a"
    }
  ]
}
```

### Handled Fields
| Field | Type | Description |
|---|---|---|
| `subscriptionId` | String (UUID) | Matches local `GraphSubscription.subscriptionId`. |
| `clientState` | String | Shared secret supplied during subscription creation. |
| `changeType` | String | Event type: `created`, `updated`, `deleted`. |
| `resource` | String | URI of the resource that changed. |
| `resourceData` | Object | Minimal Graph metadata containing resource `@odata.id` and `id`. |
| `lifecycleEvent` | String | Sent on lifecycle URL: `missed`, `subscriptionRemoved`, `reauthorizationRequired`. |
| `tenantId` | String | Azure AD Tenant ID where event originated. |

---

## 4. Authentication and Verification

Every incoming notification payload is authenticated through a multi-tier defense:

1. **Payload Structure Check:** Verifies `req.body` contains a non-empty `value` array. Malformed payloads return `400 Bad Request`.
2. **Subscription Lookup:** For each item, `subscriptionId` is resolved against `GraphSubscription` in MongoDB. If unknown, returns `404 Not Found`.
3. **Timing-Safe `clientState` Comparison:**
   - The received `clientState` is validated against the stored `clientState` or its SHA-256 hash using `timingSafeCompare`:
   ```javascript
   function timingSafeCompare(a, b) {
     if (typeof a !== 'string' || typeof b !== 'string') return false;
     const bufA = Buffer.from(a);
     const bufB = Buffer.from(b);
     if (bufA.length !== bufB.length) return false;
     return crypto.timingSafeEqual(bufA, bufB);
   }
   ```
   - Length checks occur before `crypto.timingSafeEqual` to avoid Node.js `RangeError` exceptions while mitigating timing side-channel attacks.
   - If `clientState` does not match, returns `401 Unauthorized` without leaking the expected secret.
4. **Mailbox Policy Check:** Checks `EmailIngestionPolicy.findOne({ mailbox, enabled: true })`. If disabled or missing, the notification is acknowledged with `202 Accepted` but discarded, avoiding unwanted synchronization.

---

## 5. Notification Deduplication Strategy

Microsoft Graph delivers notifications with **at-least-once** delivery guarantees. Duplicates frequently occur during transient network retries.

### Message-Level Deduplication
When Graph sends resource-level notifications, `item.resourceData.id` contains the unique message ID:
$$\text{DedupeKey}_{\text{message}} = \text{hash}(\text{subscriptionId} + \text{resourceData.id} + \text{changeType})$$
Incoming notifications matching an existing record in `SupportEmailWebhookEvent` within the deduplication window are safely recorded as duplicate and do not trigger redundant sync executions.

### Collection-Level Bounded Time Buckets
Folder-level subscriptions (e.g. `Users/support@guidexpert.com/mailFolders('inbox')/messages`) often omit `resourceData.id` during bulk or aggregate change wake-ups.
If keyed permanently on `{ subscriptionId, resource, changeType }`, the **first email** would consume the key, and subsequent legitimate emails arriving hours later would be permanently ignored.

**Solution: 5-Minute Time Bucketing**
```javascript
const timeBucket = Math.floor(Date.now() / (5 * 60 * 1000));
const dedupeKey = `${subscriptionId}:${resource}:${changeType}:${timeBucket}`;
```
- Coalesces rapid burst notifications arriving in the same 5-minute interval into a single wake-up.
- Naturally unlocks in subsequent 5-minute windows so future emails always wake up the sync engine.

---

## 6. Monotonic Sync Coordination

When a valid notification arrives, `controllers/supportEmailWebhookController.js` invokes:
```javascript
await signalMailboxSync({ mailbox, folder });
```

### Monotonic Concurrency Guarantee
1. **Atomic Signal (`$inc`):** `signalMailboxSync` increments `syncRequestVersion: 1` and sets `hasPendingSync: true` on `EmailSyncCursor`.
2. **Lock Acquisition (`acquireSyncLock`):** A worker acquires the lock only if `syncStatus` is `'idle'` or if a previous worker crashed (`syncLeaseExpiresAt <= now`).
3. **Pass Loop (`runCoalescedSync`):**
   - Captures `syncRequestVersion` before running a delta sync pass.
   - Executes `syncPassFn` (delta query -> message normalization -> idempotent ingestion).
   - In `releaseSyncLockIfNoPending`, checks if new requests arrived while syncing:
     $$\text{syncRequestVersion} > \text{capturedVersion} \lor \text{hasPendingSync} = \text{true}$$
   - If new notifications arrived during the pass, the worker **immediately loops** to process the fresh changes without releasing and re-acquiring the lock.
   - Once all pending versions are satisfied, the worker atomically resets `hasPendingSync: false` and sets `syncStatus: 'idle'`.

---

## 7. Subscription Lifecycle Management

Microsoft Graph subscriptions for Outlook message resources have a hard maximum lifetime of **4,230 minutes** (~2.93 days). GuideXpert manages this lifecycle via `services/supportEmail/subscriptionService.js`:

| Parameter | Value | Rationale |
|---|---|---|
| `DEFAULT_EXPIRATION_MINUTES` | `4200` (~2.91 days) | Safely within Graph's 4230 min ceiling. |
| `MIN_EXPIRATION_MARGIN_HOURS` | `24` hours | Renewals occur when less than 24h remain. |
| `changeType` | `created,updated` | Tracks new emails and status changes. |

### Lifecycle Operations
- `createSubscription({ mailbox, folder })`: Checks for existing active unexpired subscriptions. If found, returns existing without calling Graph. If forced or absent, generates random 64-hex-char `clientState`, calls `POST /subscriptions`, and records `status: 'active'`.
- `renewSubscription({ subscriptionId })`: Calls `PATCH /subscriptions/{id}` with new `expirationDateTime`.
- `deleteSubscription({ subscriptionId })`: Calls `DELETE /subscriptions/{id}` and updates status to `'deleted'`. Handles 404 cleanly if already purged by Graph.
- `syncSubscriptionHealth({ mailbox })`:
  1. If missing -> creates fresh subscription.
  2. If expired -> marks expired and creates fresh replacement.
  3. If $< 24\text{ hours}$ remain -> calls `renewSubscription()`.
  4. If renewal returns 404 (purged in Graph) -> automatically creates fresh replacement.

---

## 8. Failure and Recovery Scenarios

| Failure Scenario | Graph Response | System Detection | Recovery Mechanism |
|---|---|---|---|
| **Graph Purged Subscription** | `404 Not Found` on PATCH | `renewSubscription` throws 404 | `syncSubscriptionHealth` catches 404, marks old subscription `expired`, and issues `POST /subscriptions` to establish fresh subscription. |
| **Dropped / Missed Webhooks** | No HTTP request sent | Scheduled cron runs every 15m | `reconcileMailbox` detects `now - lastSuccessfulSyncAt > 15m` and executes catchup delta sync. |
| **Graph Notification Loss** | Lifecycle event: `missed` | Received at `/webhooks/graph` | `handleLifecycleNotification` handles `'missed'` by immediately calling `signalMailboxSync()`. |
| **Tenant Admin Revoked Consent** | Lifecycle: `reauthorizationRequired` | Received at `/webhooks/graph` | Marks subscription with warning error; alerts administrators via health log. |
| **Worker Crashed Mid-Sync** | Serverless function killed | `syncStatus: 'syncing'` with expired lease | Next worker or cron detects `syncLeaseExpiresAt <= now`, reclaims lease atomically, and completes pending delta sync. |

---

## 9. Scheduled Reconciliation Engine

The scheduled reconciliation engine (`services/supportEmail/reconciliationService.js`) provides a scheduled polling safety net to recover unobserved messages if webhooks are delayed, dropped, or unconfigured:

- **Endpoint:** `ALL /api/cron/support-email-reconcile`
- **Protection:** `verifyCronSecret` (requires `CRON_SECRET` or `GUIDEXPERT_CRON_SECRET` via Bearer token, header, or query key).
- **Execution Budget:** Default `45,000 ms` (45 seconds). Iterates across all active ingestion policies. If execution time approaches the budget, it breaks gracefully to prevent Vercel 60s function timeouts.
- **Actions per Mailbox:**
  1. Audits and repairs Graph subscription health.
  2. Checks if sync is needed (pending signal, crashed lease, or $> 15\text{ min}$ elapsed since last sync).
  3. Runs coalesced delta sync pass.
  4. Updates pending webhook event records from `received` to `processed`.

---

## 10. Vercel Serverless Deployment Considerations

1. **Cold Start Immunity:** Webhook handshake validation queries (`?validationToken=...`) bypass the database connection gate, guaranteeing sub-50ms responses well within Graph's 10s deadline.
2. **Immediate 202 Response:** Notification POST requests persist the webhook event, trigger monotonic `signalMailboxSync`, and return `202 Accepted` immediately without blocking on delta sync completion.
3. **Bounded Cron Budget:** `runAllReconciliations` strictly enforces `batchBudgetMs = 45000` to avoid function timeout on Vercel Hobby/Pro plans.
4. **Idempotent Retries:** If Vercel kills a container during sync, the 60-second sync lease ensures subsequent invocations recover smoothly.

---

## 11. Security & Identifier Consistency Considerations

- **Zero Plaintext at Rest (`clientState`):** The shared secret `clientState` is held in memory only during subscription creation and is **never** persisted to MongoDB. Only its cryptographic hash (`clientStateHash`) is retained in `GraphSubscription`.
- **Keyed HMAC Support:** The system computes and verifies `clientStateHash` using a keyed HMAC via `MS_GRAPH_CLIENT_STATE_SECRET` when configured, with seamless backward-compatible fallback to SHA-256.
- **Timing Attack Mitigation:** Constant-time buffer comparison (`timingSafeCompare` using `crypto.timingSafeEqual`) ensures malicious actors cannot deduce `clientState` characters through timing discrepancies.
- **Zero Token Leakage:** Authentication headers, validation tokens, and `clientState` are never exposed in error logs, API responses, or diagnostic metadata.
- **RBAC Custom Resource Scopes:** The application operates strictly within Exchange Online RBAC for Applications assigned to the designated support mailbox, preventing tenant-wide mailbox access.
- **Message Identifier Consistency:**
  - Graph webhook notifications deliver minimal `resourceData.id` identifiers representing ordinary Graph message IDs. These are strictly used for webhook event deduplication and are never mistaken for immutable IDs.
  - The authoritative delta sync engine (`deltaSyncService`) normalizes incoming messages and leverages RFC 2822/5322 `internetMessageId` with a partial unique index (`internetMessageId_1_unique_partial`).
  - When messages move between folders or return to the Inbox with a new ordinary Graph ID, the immutable RFC 2822 `internetMessageId` safely updates the existing `SupportEmail` document without creating duplicate tickets or running destructive mutations.

---

## 12. Environment Variables Reference

| Variable | Required in Phase 2B | Description | Example |
|---|---|---|---|
| `MS_GRAPH_WEBHOOK_URL` | Yes (Production) | Public HTTPS URL for Graph notifications | `https://api.guidexpert.com/api/support-email/webhooks/graph` |
| `MS_GRAPH_LIFECYCLE_URL` | Optional | Public HTTPS URL for Graph lifecycle events | `https://api.guidexpert.com/api/support-email/webhooks/graph/lifecycle` |
| `MS_GRAPH_CLIENT_STATE_SECRET` | Optional (Recommended) | Key for HMAC hashing of clientState secrets | `sec_hmac_graph_state_4f8a...` |
| `CRON_SECRET` | Yes | Shared secret for securing cron endpoints | `sec_cron_live_7a8b9c...` |
| `GUIDEXPERT_CRON_SECRET` | Optional | Fallback secret for cron endpoints | `sec_cron_live_7a8b9c...` |
| `MS_GRAPH_TENANT_ID` | Yes | Azure AD Tenant ID | `d16c5264-b81b-4d43-...` |
| `MS_GRAPH_CLIENT_ID` | Yes | Entra Application Client ID | `b54e7d98-1e43-4f21-...` |
| `MS_GRAPH_CLIENT_SECRET` | Yes | Entra Application Client Secret | `~X18Q~...` |

---

## 13. Vercel Cron Configuration

Add the following cron definition to `vercel.json`:
```json
{
  "crons": [
    {
      "path": "/api/cron/support-email-reconcile",
      "schedule": "*/15 * * * *"
    }
  ]
}
```
*Executes every 15 minutes to guarantee continuous reconciliation and auto-renewal of expiring Graph subscriptions.*

---

## 14. Local Development & Testing Guide

### Testing Handshake via cURL
```bash
# Test validation handshake (POST method as issued by Microsoft Graph)
curl -X POST -i "http://localhost:5000/api/support-email/webhooks/graph?validationToken=test-token-12345"
# Expected: HTTP 200 OK, Content-Type: text/plain, Body: test-token-12345

# Test validation handshake on dedicated lifecycle endpoint
curl -X POST -i "http://localhost:5000/api/support-email/webhooks/graph/lifecycle?validationToken=lifecycle-token-67890"
# Expected: HTTP 200 OK, Content-Type: text/plain, Body: lifecycle-token-67890
```

### Testing with ngrok for Live Graph Testing
```bash
# 1. Start local tunnel
ngrok http 5000

# 2. Update MS_GRAPH_WEBHOOK_URL in .env
MS_GRAPH_WEBHOOK_URL=https://<your-ngrok-subdomain>.ngrok-free.app/api/support-email/webhooks/graph

# 3. Create subscription via Node REPL or test harness
```

### Running Automated Test Suites
```bash
# Run Phase 2B test suites
node --test test/supportEmailWebhook.test.js
node --test test/supportEmailSubscription.test.js
node --test test/supportEmailReconciliation.test.js

# Run full support email regression suite
node --test test/supportEmail*.test.js test/ensureSupportEmailIndexes.test.js
```

---

## 15. Staging Verification Runbook

### Prerequisites
1. Staging deployment accessible over public HTTPS.
2. Azure AD application configured with Exchange Online RBAC for the staging mailbox.
3. `MS_GRAPH_WEBHOOK_URL` set to staging endpoint.

### Step-by-Step Procedure
1. **Verify Handshake:**
   ```bash
   curl -X POST -i "https://staging-api.guidexpert.com/api/support-email/webhooks/graph?validationToken=probe-token"
   ```
   Confirm response is HTTP 200 with body `probe-token`, `Content-Type: text/plain`, and response time $< 100\text{ ms}$.

   Also probe the dedicated lifecycle endpoint if configured separately:
   ```bash
   curl -X POST -i "https://staging-api.guidexpert.com/api/support-email/webhooks/graph/lifecycle?validationToken=probe-lifecycle-token"
   ```
2. **Execute Initial Subscription:**
   Invoke `subscriptionService.createSubscription({ mailbox: 'support-staging@guidexpert.com' })`.
   Confirm subscription document in MongoDB has `status: 'active'` and `expirationDateTime` $\approx +70\text{ hours}$.
3. **Send Live Test Email:**
   Send an email to `support-staging@guidexpert.com`.
   Check MongoDB logs:
   - `SupportEmailWebhookEvent` created with `status: 'processed'`.
   - `EmailSyncCursor` updated with fresh `deltaLink`.
   - `SupportEmail` document ingested with `graphMessageId` and `status: 'pending'`.
4. **Verify Reconciliation Cron:**
   ```bash
   curl -i -H "Authorization: Bearer $CRON_SECRET" "https://staging-api.guidexpert.com/api/cron/support-email-reconcile"
   ```
   Confirm response HTTP 200 with `outcome.processedCount >= 1`.

---

## 16. Verification Stages & Production Blockers

### Distinction Between Verification Stages
- **Local Implementation Verification:** 100% automated test coverage using in-memory MongoDB and mocked Microsoft Graph HTTP client. Proves logic, timing safety, idempotency, and state machine transitions.
- **Vercel Configuration Verification:** Express routing, database connection bypass gates, and `vercel.json` 15-minute cron definitions verified in repository source.
- **Staging Verification (Pending Deployment):** Requires deploying to a publicly accessible HTTPS domain with globally trusted TLS certificates and testing POST handshakes via live cURL.
- **Live Microsoft Graph Verification (Pending Tenant Onboarding):** Requires live Azure AD tenant credentials, Exchange Online application RBAC role assignment on the target support mailbox, and active subscription establishment.
- **Production Readiness:** Blocked until staging verification and live tenant onboarding are executed and validated.

### Known Limitations & Production Blockers
1. **Public HTTPS Requirement:** Microsoft Graph cannot deliver webhooks to `localhost` or HTTP endpoints. Live testing strictly requires a public HTTPS URL (via ngrok in development, or valid domain in staging/production).
2. **TLS Certificate Requirements:** Microsoft Graph drops connections if the webhook endpoint uses self-signed SSL certificates. Production must use a certificate signed by a globally trusted Certificate Authority.
3. **Exchange Online Mailbox Scope:** The Azure application must have the custom Exchange Online RBAC role assigned for the exact mailbox address configured in `EmailIngestionPolicy`.
4. **Subscription Lifetime Ceiling:** Graph strictly caps mail subscription lifetimes at 4,230 minutes. Subscriptions must be renewed at least once every 2.9 days; the scheduled 15-minute reconciliation cron handles this automatically.

