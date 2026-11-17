# GuideXpert Support Email Automation — Phase 2B: Microsoft Graph Webhooks & Notifications

## Document Information
- **Document Version:** 1.2.0
- **Phase:** 2B — Microsoft Graph Webhooks & Notifications
- **Repository:** GuideXpert-Backend
- **Branch:** `feat/support-email-phase-2b-webhooks`
- **Baseline Commit:** `a4fb3ebb85c165b312de67718a4fc2a24140aa41`
- **Status:** Complete & Locally Hardened (Mocked Suites Pass; Live Exchange Online RBAC & Staging Deployment Pending / Blocked)
- **Last Updated:** 2026-11-15

---

## 1. Webhook Architecture and End-to-End Flow

Microsoft Graph Webhooks provide asynchronous wake-up signals whenever email messages arrive or change in the configured Exchange Online mailbox. In GuideXpert's architecture:

> **Fundamental Principle:** Microsoft Graph webhooks are wake-up signals, **not** the source of truth. Notification payloads are never used to directly ingest email bodies, download attachments, or spawn support tickets. Instead, validated notifications trigger monotonic synchronization passes against the existing unfiltered delta sync engine implemented in Phase 2A.

```
                      Microsoft Graph / Exchange Online
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            │ [1] Webhook Handshake (Standard)                  │ [2] Change Notification
            │ POST /api/support-email/webhooks/graph            │ POST /api/support-email/webhooks/graph
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
│ - Exact validationToken string│           │ - Constant-time clientState verify    │
│ - Return 200 text/plain       │           │ - Verify active GraphSubscription     │
│ - Validate resource mailbox scope     │
│ - Pre-validate ENTIRE batch (atomic)  ││   within milliseconds         │           │ - Deduplicate (resourceData / bucket) │
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

- **HTTP Method:** `POST` (Standard Microsoft Graph validation specification. Note: `GET` is supported as a secondary fallback for local proxy tools or health checks, but Microsoft Graph production delivery standard is `POST`).
- **Query Parameter:** `?validationToken=<token>`
- **Token Decoding & Preservation:** Express's query parser decodes URL-encoded parameters once. The controller explicitly returns `String(req.query.validationToken)` without secondary decoding, ensuring exact token preservation even if literal percent sequences are transmitted.
- **Deadline:** Microsoft Graph requires an HTTP 200 response with the exact token inside **10 seconds**, otherwise the subscription creation call immediately fails with `Invalid: Subscription validation request failed`.
- **Response Format:**
  - Status: `200 OK`
  - `Content-Type`: `text/plain; charset=utf-8`
  - Body: Plain text of the exact validation token (no JSON wrapping, no quotes, no HTML).

### Database Gate Bypass (`shouldBypassDbGate`)
On Vercel serverless functions, database cold starts (connecting to MongoDB Atlas through SSL/TLS handshakes) can take between 2 to 6 seconds under heavy load. If incoming subscription validations were gated behind MongoDB connection establishment, cold starts could exceed Graph's strict 10s deadline.

In `server.js`, the database gate middleware explicitly inspects incoming requests and restricts database bypass strictly to exact approved routes:
```javascript
const GRAPH_WEBHOOK_EXACT_PATHS = new Set([
  '/api/support-email/webhooks/graph',
  '/api/support-email/webhooks/graph/',
  '/api/support-email/webhooks/graph/lifecycle',
  '/api/support-email/webhooks/graph/lifecycle/'
]);

function shouldBypassDbGate(req) {
  if (req.path === '/api/health') return true;
  // Microsoft Graph subscription validation handshake must never be blocked by database connection.
  // Restricted strictly to the exact primary and lifecycle webhook endpoints.
  if (GRAPH_WEBHOOK_EXACT_PATHS.has(req.path) && req.query && typeof req.query.validationToken !== 'undefined') {
    return true;
  }
  if (req.method !== 'GET') return false;
  return /^\/(?:api\/)?blogs(?:\/[^/]+)?\/?$/.test(req.path);
}
```
Validation handshake requests respond in **under 5 milliseconds**, completely independent of MongoDB state. Arbitrary subpaths, unauthorized prefixes, or unapproved routes cannot bypass the database gate.

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
      "resource": "users/support@niatindia.com/mailFolders('inbox')/messages/AAMkAG...",
      "resourceData": {
        "@odata.type": "#Microsoft.Graph.Message",
        "@odata.id": "users/support@niatindia.com/mailFolders('inbox')/messages/AAMkAG...",
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
3. **Batch Atomicity:** Every item in `req.body.value` is authenticated before **any** item is persisted or acknowledged. A single invalid item rejects the whole batch with `400`, `401`, or `404`. This prevents a partially persisted batch from creating ambiguous Graph retry semantics.
4. **Resource Scope Validation:** For change notifications, the notification `resource` must resolve to the same mailbox as the stored subscription. `resourceBelongsToSubscription()` accepts both Graph path styles (`users/<mailbox>/...` and `users('<mailbox>')/...`) but rejects a resource naming a different mailbox with `400 Bad Request`. Lifecycle notifications may omit `resource` and are exempt from this check.
5. **Cryptographic `clientState` Verification at Rest:**
   - Plaintext `clientState` is **never stored in MongoDB**. `models/GraphSubscription.js` retains strictly `clientStateHash`, `clientStateHashScheme`, and `clientStateKeyId`.
   - Incoming `clientState` is verified using `verifySubscriptionClientState()` — a versioned, fail-closed, constant-time function that selects the cryptographic algorithm based on **trusted persisted subscription metadata** (`clientStateHashScheme` and `clientStateKeyId`), not on live environment inference:
   ```javascript
   // Case 1: Explicit 'hmac-sha256' scheme (all subscriptions created after versioning)
   // Key selected by clientStateKeyId — primary or previous key for rotation overlap.
   // Strictly does NOT fall back to unkeyed SHA-256 for HMAC subscriptions (fail-closed).

   // Case 2: Explicit 'sha256' scheme (unkeyed legacy subscriptions, no HMAC secret configured)
   // Plain SHA-256 comparison — no HMAC key lookup.

   // Case 3: null/undefined scheme (subscriptions created before scheme versioning was added)
   // Backward-compatibility: tries HMAC with current and previous keys, then falls back to SHA-256.
   ```
   - Supported environment variables for key versioning:
     - `MS_GRAPH_CLIENT_STATE_SECRET` — Current HMAC key (required for HMAC-SHA256 subscriptions)
     - `MS_GRAPH_CLIENT_STATE_KEY_ID` — Identifier for the current key (default: `'primary'`)
     - `MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS` — Previous HMAC key for rotation overlap
     - `MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID` — Identifier for the previous key (default: `'previous'`)
   - Length checks occur before `crypto.timingSafeEqual` to avoid Node.js `RangeError` exceptions while mitigating timing side-channel attacks.
   - If `clientState` does not match, the controller returns `401 Unauthorized` without leaking the expected secret or hash.
   - **Production Guard (Fail-Closed):** When `MS_GRAPH_CLIENT_STATE_SECRET` is unset, `createSubscription` throws a configuration error immediately, before any network request or database mutation. It does **not** silently fall back to unkeyed SHA-256. Set the secret before creating any Graph subscriptions in production or staging.
   - **Secret Rotation with Overlap:**
     - Microsoft Graph does **not** allow updating `clientState` on existing subscriptions via `PATCH /subscriptions/{id}`.
     - Safe rotation: set `MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS` = old key value and `MS_GRAPH_CLIENT_STATE_SECRET` = new key value. Old subscriptions continue authenticating via Case 1's previous-key path. New subscriptions are created with the new key. When all old subscriptions have expired or been replaced, remove the previous key variables.
6. **Mailbox Policy Check:** Checks `EmailIngestionPolicy.findOne({ mailbox, enabled: true })`. If disabled or missing, the notification is acknowledged with `202 Accepted` but discarded, avoiding unwanted synchronization.

---

## 5. Notification Deduplication Strategy

Microsoft Graph delivers notifications with **at-least-once** delivery guarantees. Duplicates frequently occur during transient network retries.

### Message-Level Deduplication
When Graph sends resource-level notifications, `item.resourceData.id` contains the unique message ID:
$$\text{DedupeKey}_{\text{message}} = \text{hash}(\text{subscriptionId} + \text{resourceData.id} + \text{changeType})$$
Incoming notifications matching an existing record in `SupportEmailWebhookEvent` within the deduplication window are safely recorded as duplicate and do not trigger redundant sync executions.

### Collection-Level Bounded Time Buckets
Folder-level subscriptions (e.g. `users/support@niatindia.com/mailFolders('inbox')/messages`) often omit `resourceData.id` during bulk or aggregate change wake-ups.
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
- `createSubscription({ mailbox, folder })`: Checks for existing active unexpired subscriptions. If found, returns existing without calling Graph. Otherwise acquires the distributed single-flight reservation described below, generates a random 64-hex-char `clientState`, calls `POST /subscriptions`, and records `status: 'active'`.
- `renewSubscription({ subscriptionId })`: Calls `PATCH /subscriptions/{id}` with new `expirationDateTime`.
- `deleteSubscription({ subscriptionId })`: Calls `DELETE /subscriptions/{id}` and updates status to `'deleted'`. Handles 404 cleanly if already purged by Graph.
- `syncSubscriptionHealth({ mailbox })`:
  1. If missing -> creates fresh subscription.
  2. If expired -> marks expired and creates fresh replacement.
  3. If $< 24\text{ hours}$ remain -> calls `renewSubscription()`.
  4. If renewal returns 404 (purged in Graph) -> automatically creates fresh replacement.
  5. If a `reauthorizationRequired` lifecycle event was recorded -> renewal clears the warning on success.

### Single-Flight Creation Reservation (`GraphSubscriptionOperation`)

All creation paths (normal creation, `force: true`, renewal fallback, and overlapping cron runs) pass through the same reservation gate. A creation is protected by a `GraphSubscriptionOperation` document with a deterministic `reservationKey` (`mailbox|folder`) and a unique partial index (`reservationKey_1_unique_partial`). Acquisition is a single atomic `insert`, not `findOne` followed by `create`, so two concurrent workers cannot both proceed.

| Operation state | `failureClassification` | Lease unexpired? | Blocks new creation? |
|---|---|---|:---:|
| `pending` | — | Yes | **Yes** |
| `pending` | — | No | No (expired holder is marked `abandoned` and recovered) |
| `failed` | `ambiguous` | Yes | **Yes** |
| `failed` | `ambiguous` | No | No |
| `failed` | `confirmed_rejection` | Any | No (conclusive; reservation is released immediately) |
| `completed` / `abandoned` | — | Any | No |

Additional guarantees:
- **`force: true` cannot bypass an active reservation.** Forced replacement still contends for the same slot; it only skips the existing-subscription lookup.
- **Ownership verification:** release and extend operations match both `operationId` and `reservationKey`, so a stale worker cannot release or extend another worker's lease.
- **TOCTOU closure:** the existing-active-subscription lookup is repeated **after** reservation acquisition. Two workers that both observed "no subscription" cannot both create one.
- **Lease duration exceeds the full request window:** `calculateCreationLeaseMs()` uses the Graph client's `timeoutMs`, `maxRetries`, and `maxBackoffMs`:
  $$\text{lease} = \max(120\text{s},\ \text{timeoutMs} \times (\text{maxRetries}+1) + \text{maxBackoffMs} \times \text{maxRetries} + 60\text{s})$$
  With the default client configuration (`15s`, `3` retries, `30s` max backoff) the lease is **210 seconds**. A delayed request cannot outlive its own protection lease.
- **Legacy records:** operations created before `reservationKey` existed are still honoured through an active-lease lookup (`reservationKey: null`, unexpired `pending` or ambiguous `failed`), so upgrades do not open a duplicate-creation window.
- **Failure classification:** `classifyGraphError()` treats timeout/`ECONNRESET`/`ECONNABORTED`/`ECONNREFUSED`/`EPIPE`/DNS failures, HTTP 408, HTTP 429, HTTP 5xx, malformed success responses, and unknown failures as **ambiguous**. Ambiguous failures keep the reservation and renew its lease. HTTP 400/401/403/404/etc. are **confirmed rejections**; the reservation is released and the lease expired so a retry can proceed immediately.
- **DB failure after Graph success:** if MongoDB persistence fails after Graph returned a `subscriptionId`, the operation retains that `subscriptionId` and an ambiguous reservation lease, preventing reconciliation from deleting a subscription that is still being established.

---

## 8. Failure and Recovery Scenarios

| Failure Scenario | Graph Response | System Detection | Recovery Mechanism |
|---|---|---|---|
| **Graph Purged Subscription** | `404 Not Found` on PATCH | `renewSubscription` throws 404 | `syncSubscriptionHealth` catches 404, marks old subscription `expired`, and issues `POST /subscriptions` to establish fresh subscription. |
| **Dropped / Missed Webhooks** | No HTTP request sent | Scheduled cron runs every 15m | `reconcileMailbox` detects `now - lastSuccessfulSyncAt > 15m` and executes catchup delta sync. |
| **Graph Notification Loss** | Lifecycle event: `missed` | Received at `/webhooks/graph` | `handleLifecycleNotification` handles `'missed'` by immediately calling `signalMailboxSync()`. |
| **Subscription Removed Remotely** | Lifecycle: `subscriptionRemoved` | Received at `/webhooks/graph` | Marks the local subscription `deleted`, records the lifecycle event, and signals a catch-up delta sync so messages are not lost while the replacement is established. |
| **Tenant Admin Revoked Consent** | Lifecycle: `reauthorizationRequired` | Received at `/webhooks/graph` | Sets a warning-level `lastError` and signals a catch-up sync. The 15-minute reconciliation cron (`syncSubscriptionHealth`) renews the subscription; a successful renewal clears the warning. |
| **Ambiguous Creation Outcome** | Timeout / reset / 408 / 429 / 5xx | `classifyGraphError` returns `ambiguous` | Reservation and lease are retained, blocking all further creation attempts (including `force: true` and cron renewals) until the lease expires. After expiry the operation is marked `abandoned` and recovered atomically. |
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
- **Remote orphan reconciliation safety:**
  - `reconcileRemoteSubscriptions()` enumerates Graph subscriptions with bounded `@odata.nextLink` pagination.
  - Destructive remote cleanup (deleting proven application-owned orphans) is performed **only** when `remoteEnum.completed === true`, i.e. every page was retrieved successfully.
  - If enumeration fails or is truncated, the result reports `completedEnumeration: false` and `cleanupSkippedIncompleteEnumeration: true`; no remote subscription is deleted and no local subscription is expired on the basis of incomplete evidence.
  - Local subscriptions are expired only when the completed remote enumeration proves their absence.
  - Deleting a remote orphan also clears any matching operation reservation, so its `subscriptionId` cannot keep blocking creation.

### Observability & Operational Telemetry

`services/supportEmail/observability.js` emits privacy-safe structured JSON events with stable `event` names suitable for Vercel log drains/counters:

| Event | Level | Meaning |
|---|---|---|
| `support_email_webhook_batch_received` | info | Notification batch accepted for validation (count only). |
| `support_email_webhook_duplicate` | info | Duplicate delivery suppressed by dedupe key. |
| `support_email_webhook_rejected` | warn | Rejected for `missing_subscription_id`, `unknown_subscription`, `invalid_client_state`, or `resource_scope_mismatch`. |
| `support_email_subscription_creation_deferred` | info | Reservation contention; reason is `active_reservation`, `active_legacy_lease`, or `reservation_contention`. |
| `support_email_subscription_created` | info | Creation committed and reservation released. |
| `support_email_subscription_creation_rejected` | warn | Confirmed Graph rejection; reservation released. |
| `support_email_subscription_creation_ambiguous` | warn | Ambiguous outcome; reservation lease renewed. |
| `support_email_remote_orphans_detected` / `support_email_remote_orphans_deleted` | info/warn | Reconciliation outcome. |

- Mailbox addresses are masked (`s***@domain`), and keys matching sensitive patterns (`clientState`, `secret`, `token`, `authorization`, `body`, `subject`, `content`, `attachment`, addresses) are stripped recursively.
- In-process counters (`getMetricsSnapshot()`) are best-effort and per-invocation only; durable alerting must use the structured logs.
- Telemetry is suppressed under `node:test` unless `SUPPORT_EMAIL_TELEMETRY_LOGS=1`; counters remain active.

---

## 10. Vercel Serverless Deployment Considerations

1. **Cold Start Immunity:** Webhook handshake validation queries (`?validationToken=...`) bypass the database connection gate, guaranteeing sub-50ms responses well within Graph's 10s deadline.
2. **Immediate 202 Response:** Notification POST requests persist the webhook event, trigger monotonic `signalMailboxSync`, and return `202 Accepted` immediately without blocking on delta sync completion.
3. **Bounded Cron Budget:** `runAllReconciliations` strictly enforces `batchBudgetMs = 45000` to avoid function timeout on Vercel Hobby/Pro plans.
4. **Idempotent Retries:** If Vercel kills a container during sync, the 60-second sync lease ensures subsequent invocations recover smoothly.

---

## 11. Security & Identifier Consistency Considerations

- **Zero Plaintext at Rest (`clientState`):** The shared secret `clientState` is held in memory only during subscription creation and is **never** persisted to MongoDB. Only its cryptographic hash (`clientStateHash`) is retained in `GraphSubscription`.
- **Versioned Key Rotation & Metadata Tracking:** Subscriptions store `clientStateHashScheme` (`'hmac-sha256'` or `'sha256'`) and `clientStateKeyId` (`'primary'`, `'v1'`, `'v2'`). When rotating secrets, `MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS` enables existing active subscriptions to continue authenticating during key replacement.
- **Mandatory HMAC Enforcement for New Subscriptions (Fail-Closed):**
  - In production and staging (`NODE_ENV === 'production' || NODE_ENV === 'staging'`), `MS_GRAPH_CLIENT_STATE_SECRET` and `MS_GRAPH_CLIENT_STATE_KEY_ID` are **strictly mandatory**.
  - Calling `createSubscription()` without `MS_GRAPH_CLIENT_STATE_SECRET` throws a fail-closed configuration error before any network request or database mutation occurs.
  - Calling `createSubscription()` without `MS_GRAPH_CLIENT_STATE_KEY_ID` throws a fail-closed configuration error.
  - Setting a previous secret without a previous key ID, or setting identical primary and previous key IDs, throws a fail-closed error.
  - The `allowUnkeyed` parameter is strictly forbidden in production and staging (`NODE_ENV === 'production' || NODE_ENV === 'staging'`).
- **Cryptographic Scheme Isolation:** Subscriptions created with `'hmac-sha256'` strictly evaluate HMAC keys and **never** fall back to unkeyed SHA-256, completely eliminating algorithm confusion and fallback vulnerabilities.
- **Timing Attack Mitigation:** Constant-time buffer comparison (`timingSafeCompare` using `crypto.timingSafeEqual`) ensures malicious actors cannot deduce `clientState` characters through timing discrepancies.
- **Zero Token Leakage:** Authentication headers, validation tokens, and `clientState` are never exposed in error logs, API responses, or diagnostic metadata.
- **Webhook Resource Confinement:** Client-state authentication proves the sender knows the subscription secret; the additional resource-scope check proves the notification names the same mailbox as the stored subscription. A spoofed notification cannot cause synchronization of a different mailbox.
- **Batch Atomicity:** All notifications in a batch are authenticated and policy-checked before any is persisted. A mixed valid/invalid batch is rejected as a whole, so Graph's retry cannot double-process the valid prefix.
- **Privacy-Safe Telemetry:** Structured operational events mask mailbox addresses, strip secret/token/body/subject/attachment keys, bound string lengths, and never emit raw notification payloads.
- **Remote/Local State Consistency (Documented Design Boundary):**
  - When `syncSubscriptionHealth` detects multiple active subscription records in MongoDB, it marks older duplicates as `'expired'` using `updateMany` (a local-only operation). It does **not** call `DELETE /subscriptions/{id}` on those duplicate remote Graph subscriptions automatically.
  - The duplicate remote subscriptions continue to exist in Microsoft Graph until they naturally expire (up to 4,230 minutes). During this window, notifications from these locally-expired-but-remotely-active subscriptions arrive at the webhook endpoint. Because the controller looks up subscriptions by `subscriptionId` without filtering on local `status`, they still authenticate correctly and are processed safely.
  - This is an intentional safe behavior: the duplicate cleanup is a local bookkeeping operation. Auto-deleting remote subscriptions during health sync would risk data loss if two Vercel instances ran concurrently.
  - To proactively delete remote duplicates, call `deleteSubscription({ subscriptionId })` explicitly with administrator intent.
- **Remote Orphan Discovery & Bounded Safe Reconciliation:**
  - If a process crashes after Graph `POST /subscriptions` succeeds but before MongoDB persistence, an orphaned remote subscription is left in Microsoft Graph.
  - `SubscriptionService.prototype.reconcileRemoteSubscriptions({ mailbox, folder, deleteOrphans })` safely enumerates remote subscriptions via `GET /subscriptions`, filters by mailbox resource and application `notificationUrl`, and compares them with MongoDB records.
  - In audit mode (`deleteOrphans: false`), it reports `{ matched, remoteOrphans, localOrphans }` without modifying any remote or local state.
  - In cleanup mode (`deleteOrphans: true`), it only deletes proven remote orphans that belong to this application (verified matching resource and `notificationUrl`), and marks local records absent from Graph as `'expired'`.
  - Destructive cleanup is skipped entirely unless pagination completed (`remoteEnum.completed === true`). An incomplete enumeration cannot prove absence, so it never causes deletion or expiry.
  - It **never** deletes unknown subscriptions without proving application ownership.
- **Legacy Record Migration & Retirement:**
  - Subscriptions created before scheme versioning have `clientStateHashScheme: null`.
  - The verifier maintains Case 3 backward compatibility for these legacy records.
  - `SubscriptionService.prototype.migrateLegacySubscriptionRecord({ subscriptionId, targetScheme, targetKeyId, clientState, verificationSecret })` allows safe migration with the following security invariants:
    - **SHA-256 migration** (`targetScheme: 'sha256'`): Safe without proof. Null-scheme records defaulted to SHA-256; making this explicit is an identity operation. The hash is not mutated.
    - **HMAC-SHA256 migration** (`targetScheme: 'hmac-sha256'`): Requires the caller to supply both `clientState` (plaintext) and `verificationSecret`. The function recomputes the HMAC and verifies it matches the stored hash before updating metadata. This prevents silently relabeling a SHA-256 hash as HMAC-SHA256.
    - A metadata-only relabel (no hash verification) **cannot** convert a SHA-256 hash into a valid HMAC record. Any such attempt will fail verification at notification time, causing all future webhook authentications for that subscription to fail.
    - **Unknown provenance** (hash algorithm not determinable from available evidence): Do not attempt migration. Leave as null-scheme. The subscription will continue authenticating via Case 3 until natural 70-hour expiration.
  - Because all Graph subscriptions expire within 70 hours, legacy records expire naturally upon renewal. Once all active records carry explicit schemes, Case 3 will be permanently retired.
- **RBAC Custom Resource Scopes (Prerequisite — Pending Verification):**
  - The intended production architecture strictly mandates Exchange Online RBAC for Applications assigned exclusively to the production support mailbox (`support@niatindia.com`).
  - **Critical Security Distinction:** Source code and unit tests cannot enforce tenant mailbox boundaries. If an administrator inadvertently grants tenant-wide Application `Mail.Read` in Entra ID without custom Exchange Online RBAC scoping, Microsoft Graph grants access to *every* mailbox in the organization.
  - Furthermore, `Test-ServicePrincipalAuthorization` tests Exchange RBAC assignments, but does *not* detect broad tenant-wide Entra ID grants.
  - Therefore, mailbox scoping is an **unverified prerequisite** until an authorized tenant administrator connects to Exchange Online PowerShell and independently proves scoping with zero Entra Application permissions.
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
| `MS_GRAPH_CLIENT_STATE_SECRET` | Yes (Mandatory) | Primary secret for HMAC hashing of clientState (fail-closed if missing) | `sec_hmac_graph_state_4f8a...` |
| `MS_GRAPH_CLIENT_STATE_KEY_ID` | Yes (Mandatory) | Key ID for primary secret (default: 'primary') | `v2` |
| `MS_GRAPH_CLIENT_STATE_SECRET_PREVIOUS` | Optional | Previous secret for graceful rotation overlap | `sec_hmac_graph_state_prev...` |
| `MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID` | Optional (Required if previous secret set) | Key ID for previous secret (default: 'previous') | `v1` |
| `CRON_SECRET` | Yes | Shared secret for securing cron endpoints | `sec_cron_live_7a8b9c...` |
| `GUIDEXPERT_CRON_SECRET` | Optional | Fallback secret for cron endpoints | `sec_cron_live_7a8b9c...` |
| `MS_GRAPH_TENANT_ID` | Yes | Azure AD Tenant ID | `d16c5264-b81b-4d43-...` |
| `MS_GRAPH_CLIENT_ID` | Yes | Entra Application Client ID | `b54e7d98-1e43-4f21-...` |
| `MS_GRAPH_CLIENT_SECRET` | Yes | Entra Application Client Secret | `~X18Q~...` |
| `SUPPORT_EMAIL_TELEMETRY_LOGS` | Optional | Set to `1` to emit structured telemetry during `node:test` runs. Production telemetry is always emitted. | `1` |

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
*Executes every 15 minutes to run periodic reconciliation passes and audit expiring Graph subscriptions.*

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
node --test test/supportEmailWebhookSecurity.test.js
node --test test/supportEmailSubscription.test.js
node --test test/supportEmailReservation.test.js
node --test test/supportEmailReconciliation.test.js

# Run full support email + related regression suite (333 tests, 0 failures, 27 suites, ~16–17s)
node --test test/supportEmail*.test.js test/ensureSupportEmailIndexes.test.js test/whatsappRetryRules.test.js test/gupshupWebhookFlow.test.js test/demoMeetLiveWindows.test.js
```

### Additional Phase 2B Regression Suites

| Suite | Tests | Focus |
|---|---:|---|
| `test/supportEmailReservation.test.js` | 25 | Atomic reservation acquisition, unique partial index contention, `force: true`, legacy leases, ambiguous vs confirmed classification, lease duration, ownership-scoped release/extend, stale recovery, incomplete-enumeration cleanup guard, DB failure after Graph success, lifecycle reauthorization renewal. |
| `test/supportEmailWebhookSecurity.test.js` | 7 | Resource-scope validation for both Graph path styles, cross-mailbox spoof rejection, atomic mixed-batch rejection, `subscriptionRemoved` / `reauthorizationRequired` lifecycle recovery, duplicate-delivery signal-gap repair. |
| `test/supportEmailReconciliation.test.js` | 13 | Cron budget, multi-mailbox iteration, scheduled remote orphan cleanup, reservation release on orphan deletion. |
| `test/ensureSupportEmailIndexes.test.js` | 5 | Index plan includes `reservationKey_1_unique_partial` and the subscription lookup index. |

### Test Coverage Matrix — `test/supportEmailSubscription.test.js`

| Test # | Requirement | Verification |
|--------|-------------|--------------|
| 1 | createSubscription creates new subscription | Graph POST issued; MongoDB persisted |
| 2 | Duplicate prevention (force=false) | No second Graph POST; existing returned |
| 3 | force=true supersedes old subscription | Old marked expired; new created |
| 4 | renewSubscription calls PATCH | Expiration updated in Graph and MongoDB |
| 5 | renewSubscription marks expired on Graph 404 | Local status set to expired |
| 6 | deleteSubscription calls DELETE | MongoDB marked deleted |
| 7 | deleteSubscription handles Graph 404 cleanly | No throw; marked deleted |
| 8 | syncSubscriptionHealth creates if none | Missing subscription created |
| 9 | syncSubscriptionHealth replaces expired | Expired replaced with fresh |
| 10 | syncSubscriptionHealth renews within 24h | PATCH issued |
| 11 | syncSubscriptionHealth leaves healthy alone | No Graph calls; healthy returned |
| 12 | syncSubscriptionHealth re-creates on 404 | Graph purge handled; fresh sub created |
| 13 | lifecycle `missed` → delta sync signal | signalMailboxSync called |
| 14 | lifecycle `subscriptionRemoved` → marked deleted | Status set to deleted |
| 15 | lifecycle `reauthorizationRequired` → flagged + catch-up | subscription flagged; sync signal emitted; renewal clears warning |
| 16 | timingSafeCompare correctness | True for equal; false for differing |
| 17 | generateClientState produces 64-hex string | Crypto randomness validated |
| 18 | Separate notification and lifecycle URLs | Both URLs sent in Graph payload |
| 19 | Identical notification and lifecycle URLs | Defaults to notification URL |
| 20 | clientState never stored plaintext | Hash only; no raw secret in DB |
| 21 | Versioned key rotation — concurrent overlap | Both old and new sub notifications accepted |
| 22 | HMAC scheme isolates from SHA-256 fallback | HMAC sub rejects SHA-256 comparison |
| 23 | Explicit SHA-256 scheme authenticates | Unkeyed sub verified via Case 2 |
| 24 | Failed Graph replacement preserves old sub | Old sub remains; ambiguous retry is blocked by the active lease, then succeeds after lease expiry |
| 25 | Duplicate active subs self-heal | Older duplicates marked expired in MongoDB |
| 26 | Rotation transition: webhook controller | Both old and new sub notifications accepted via controller |
| 27 | Locally-expired sub still authenticates | Remote-active sub accepted by verifySubscriptionClientState |
| 28 | Duplicate cleanup does NOT call Graph DELETE | Zero DELETE calls; local-only operation confirmed |
| 29 | Concurrent creation returns existing | No duplicate Graph POST; existing returned |
| 30 | Graph 429 → throws, DB unchanged | Error rethrown; no MongoDB document |
| 31 | Graph 503 → throws, DB unchanged | Error rethrown; no MongoDB document |
| 32 | Graph DELETE 5xx → throws, status unchanged | Active status preserved; lastError set |
| 33 | Graph DELETE 404 → clean handling | Marked deleted; no throw |
| 34 | Unknown keyId → fail-closed | Returns false; no key guessing |
| 35 | HMAC scheme without key → fail-closed | Returns false; no SHA-256 fallback |
| 36 | Null scheme → Case 3 backward compat | HMAC with current key succeeds |
| 37 | Failed renewal preserves old sub auth | clientStateHash intact; auth succeeds |
| 38 | Missing secret → fail-closed (no accidental unkeyed) | Throws configuration error; zero Graph calls |
| 39 | Missing key ID → fail-closed | Throws configuration error; zero Graph calls |
| 40 | Previous secret without previous key ID → fail-closed | Throws configuration error; zero Graph calls |
| 41 | Primary and previous key IDs conflict → fail-closed | Throws error; zero Graph calls |
| 42 | allowUnkeyed forbidden in production/staging | Strictly rejected when NODE_ENV=production |
| 43 | Explicit allowUnkeyed=true in test env only | Unkeyed SHA-256 created when opted-in in test |
| 44 | validateHmacKeyConfig preflight validation | Validates all rules before any network call |
| 45 | listRemoteSubscriptions enumerates Graph | Calls GET /subscriptions and parses array |
| 46 | reconcileRemoteSubscriptions discovers orphans | Audits remote and local orphans without deleting |
| 47 | reconcileRemoteSubscriptions deleteOrphans=true | Deletes proven remote orphans, expires local orphans |
| 48 | migrateLegacySubscriptionRecord: sha256 safe migration | Makes implicit SHA-256 explicit without proof requirement |
| 48b | migrateLegacySubscriptionRecord: hmac-sha256 rejects without proof | Throws when clientState proof is missing |
| 48c | migrateLegacySubscriptionRecord: wrong key fails closed | Returns migrated:false when HMAC verify fails |
| 48d | migrateLegacySubscriptionRecord: correct proof succeeds | Verifies and migrates; auth remains valid |
| 48e | Metadata-only relabel cannot convert sha256 to hmac-sha256 | Stored sha256 hash cannot match hmac-sha256 computation |
| 49 | Remote orphan: POST succeeds, DB fails | Discovered and cleaned by reconcileRemoteSubscriptions |
| 50 | Remote orphan: POST times out | Discovered and cleaned by reconcileRemoteSubscriptions |
| 51 | listRemoteSubscriptions: @odata.nextLink pagination | Follows all pages up to maxPages ceiling |
| 52 | reconcileRemoteSubscriptions: pagination failure | Local subscriptions not expired when remote fails |
| 53 | Concurrency grace window: in-flight subscription protected | 2-minute grace prevents deleting concurrent creations |
| 54 | Missing expirationDateTime: treated as in-flight | Cannot prove age → conservative in-flight classification |
| 55 | Past expirationDateTime: treated as in-flight | Anomalous timestamp → conservative handling |
| 56 | Unreasonably far expiration: treated as in-flight | Beyond Graph ceiling → cannot prove application ownership |
| 57 | Old subscription (30m ago): classified as confirmed orphan | Past grace window → safe to classify and delete |
| 58 | Canonical previous key ID variable read correctly | MS_GRAPH_CLIENT_STATE_PREVIOUS_KEY_ID is canonical |
| 59 | Previous secret without canonical key ID fails closed | Throws configuration error |
| 60 | Rotation: both keys authenticate their subscriptions | Primary and previous keys work concurrently during rotation |


---

## 15. Staging Verification Runbook

### Mailbox & Environment Isolation
- **Production Mailbox:** `support@niatindia.com` (Authoritative live student support mailbox).
- **Proposed Staging Mailbox (Unconfirmed Placeholder):** `support-staging@niatindia.com`
  > [!IMPORTANT]
  > **Mailbox Existence Caveat:** The address `support-staging@niatindia.com` is a **proposed placeholder only**. Do **not** claim or assume that this mailbox exists or is licensed until confirmed by a Microsoft 365 tenant administrator.
  >
  > Before staging verification begins, the administrator must explicitly verify and confirm:
  > 1. **Existence:** The staging mailbox exists and is licensed for Exchange Online.
  > 2. **Accessibility:** The mailbox is accessible through Microsoft Graph endpoints (`/users/<staging-mailbox>/mailFolders/inbox/...`).
  > 3. **Single-Mailbox Scope:** The staging Entra application and Exchange Online RBAC role assignment grants access **strictly** to this staging mailbox.
  > 4. **Production Exclusion:** The production mailbox (`support@niatindia.com`) is strictly excluded from the staging application's management scope.
  > 5. **Database Separation:** The staging MongoDB instance is completely separate and isolated from the production MongoDB database.
- **Environment Isolation Principle:**
  - The staging deployment must **never** configure or activate an `EmailIngestionPolicy` for `support@niatindia.com`.
  - Staging `EmailIngestionPolicy` records must be strictly isolated to the confirmed staging mailbox (e.g., `support-staging@niatindia.com`).
  - Sharing database clusters or cloning production MongoDB data into staging without purging production policies creates a severe risk where staging workers establish competing Graph subscriptions or ingest production student emails.
  - Webhook URLs must match their respective environments (`MS_GRAPH_WEBHOOK_URL` pointing to `staging-api.guidexpert.com` in staging, and `api.guidexpert.com` in production).

### Prerequisites
1. Staging deployment accessible over public HTTPS with a valid public CA certificate.
2. Vercel Deployment Protection configured to exempt `/api/support-email/webhooks/graph*` from authentication.
3. Microsoft 365 Application registered with custom Exchange Online RBAC for Applications assigned strictly to the confirmed staging mailbox via `-CustomResourceScope`.
4. `MS_GRAPH_WEBHOOK_URL` set to staging endpoint.
5. Ingestion policy created in staging MongoDB for the confirmed staging mailbox with `enabled: true`.

### Step-by-Step Procedure
1. **Verify Handshake via POST (Microsoft Graph Standard):**
   ```bash
   curl -X POST -i "https://staging-api.guidexpert.com/api/support-email/webhooks/graph?validationToken=probe-token"
   ```
   Confirm response is HTTP 200 with body `probe-token`, `Content-Type: text/plain`, and response time $< 100\text{ ms}$.

   Also probe the dedicated lifecycle endpoint if configured separately:
   ```bash
   curl -X POST -i "https://staging-api.guidexpert.com/api/support-email/webhooks/graph/lifecycle?validationToken=probe-lifecycle-token"
   ```
2. **Execute Initial Subscription:**
   Invoke `subscriptionService.createSubscription({ mailbox: '<confirmed-staging-mailbox>' })`.
   Confirm subscription document in MongoDB has `status: 'active'`, `clientStateHash` populated, zero plaintext `clientState`, and `expirationDateTime` $\approx +70\text{ hours}$.
   Confirm the corresponding `GraphSubscriptionOperation` has `state: 'completed'` and `reservationKey: null`. If creation was ambiguous (timeout/429/5xx), confirm the operation retains an unexpired lease and that a second immediate attempt returns `inFlight: true` rather than issuing another Graph `POST`. After the lease expires (default 210s), retry and confirm the operation is marked `abandoned` and recovered.
3. **Send Live Test Email:**
   Send an email to the confirmed staging mailbox.
   Check MongoDB logs:
   - `SupportEmailWebhookEvent` created with `status: 'processed'`.
   - `EmailSyncCursor` updated with fresh `deltaLink`.
   - `SupportEmail` document ingested with `graphMessageId` and `status: 'pending'`.
   - Structured telemetry contains `support_email_webhook_batch_received` and `support_email_subscription_created` (masked mailbox).
4. **Verify Reconciliation Cron:**
   ```bash
   curl -i -H "Authorization: Bearer $CRON_SECRET" "https://staging-api.guidexpert.com/api/cron/support-email-reconcile"
   ```
   Confirm response HTTP 200 with `outcome.processedCount >= 1`. If remote orphan reconciliation runs, confirm `completedEnumeration: true` before any cleanup; an incomplete enumeration must report `cleanupSkippedIncompleteEnumeration: true` and perform no deletion.

---

## 16. Verification Stages & Production Blockers

### Distinction Between Verification Stages
- **Local Implementation Verification (PASS):** Verified with 333 automated tests across 27 suites passing with 0 failures (duration ~16–17s) using in-memory MongoDB and mocked Microsoft Graph HTTP client. Proves logic, mandatory fail-closed HMAC verification, timing safety, idempotency, state machine transitions, remote/local consistency behavior, atomic single-flight creation reservation via a unique partial index on `GraphSubscriptionOperation.reservationKey`, `force: true` contention, legacy-lease compatibility, ownership-scoped release/extend, stale-lease recovery, creation-age safety independent of subscription lifetime (60m, 1,440m, 4,200m), ambiguous failure blocking (HTTP 408/429/5xx, timeouts, `ECONNRESET`) versus immediate release on confirmed rejections (HTTP 400/403), bounded remote orphan discovery/reconciliation with an incomplete-enumeration cleanup guard, webhook batch atomicity and resource-scope validation, lifecycle recovery, safe migration invariants, and failure-recovery scenarios (crash before subscriptionId association, timeout, 429, 503, 404, 5xx, concurrent workers).
  > **Important Caveat:** Passing mocked automated tests does **not** prove that Microsoft Graph integration or live Exchange Online connectivity works. Unit tests only verify internal application behavior against simulated responses.
- **Vercel Configuration Verification (PASS):** Express routing, exact database connection bypass gates (`GRAPH_WEBHOOK_EXACT_PATHS`), and `vercel.json` 15-minute cron definitions verified in repository source.
- **Staging Verification (BLOCKED / PENDING DEPLOYMENT):** Requires deploying to a publicly accessible HTTPS domain with globally trusted TLS certificates and testing POST handshakes via live cURL.
- **Live Microsoft Graph Verification (BLOCKED / PENDING TENANT ONBOARDING):** Requires live Azure AD tenant credentials, Exchange Online application RBAC role assignment on the target support mailbox, and active subscription establishment.
- **Production Readiness (BLOCKED):** Strictly blocked until staging verification and live tenant onboarding are executed, verified with live telemetry, and signed off.

### Known Limitations & Production Blockers
1. **Public HTTPS Requirement:** Microsoft Graph cannot deliver webhooks to `localhost` or HTTP endpoints. Live testing strictly requires a public HTTPS URL (via ngrok in development, or valid domain in staging/production).
2. **TLS Certificate Requirements:** Microsoft Graph drops connections if the webhook endpoint uses self-signed SSL certificates. Production must use a certificate signed by a globally trusted Certificate Authority.
3. **Exchange Online Mailbox Scope:** The Azure application must have the custom Exchange Online RBAC role assigned for the exact mailbox address configured in `EmailIngestionPolicy`.
4. **Subscription Lifetime Ceiling:** Graph strictly caps mail subscription lifetimes at 4,230 minutes. Subscriptions must be renewed at least once every 2.9 days; the scheduled 15-minute reconciliation cron handles this automatically.

