# GuideXpert Support Email Automation — Phase 1: Models & Processing Foundation

## 1. Overview and Architecture

Phase 1 establishes the operational foundation for GuideXpert's inbound support email automation:
- **System of record:** MongoDB is the sole durable source of truth. All downstream systems (Google Sheets, CRM, admin dashboards) are projections.
- **Isolation:** Operates within its own domain modules (`models/SupportEmail*.js`, `services/supportEmail/*`, `constants/supportEmail.js`) with zero interference to WhatsApp, CRM, or chatbot engines.
- **Document size discipline:** MongoDB documents strictly enforce size limits: raw MIME bodies and binary attachments are prohibited. Only bounded plain text (`100 KB`), bounded HTML snippets (`20 KB`), and normalized metadata are stored in MongoDB. Raw attachment binaries are delegated to GridFS (Phase 3).
- **Prohibited Phase 1 components:** No Microsoft Graph network calls, no AI model requests, no Google Sheets synchronizations, no admin web endpoints, no cron mounts, and no remote auto-indexing.

---

## 2. Collections and Data Models

### 2.1 Collection Inventory

| # | Collection Name | Mongoose Model | Primary Identity | Key Indexes | Purpose |
|---|---|---|---|---|---|
| 1 | `supportemails` | `SupportEmail` | `graphMessageId` (unique) | unique `graphMessageId`, unique partial `internetMessageId`, `{receivedDateTime: -1}`, `{conversationId: 1, receivedDateTime: -1}`, `{'pipeline.state': 1, receivedDateTime: 1}` | Inbound email metadata, bounded body text, pipeline stage status |
| 2 | `supportemailattachments` | `SupportEmailAttachment` | `{emailId, graphAttachmentId}` (unique) | unique `{emailId, graphAttachmentId}`, `{emailId: 1, isInline: 1}`, `{sha256: 1}` | Attachment metadata, extraction status, text extract |
| 3 | `supportemailprocessingjobs` | `SupportEmailProcessingJob` | `{emailId, stage}` (unique) | unique `{emailId, stage}`, `{state: 1, nextAttemptAt: 1, priority: -1}`, `{leaseExpiresAt: 1}` | Durable queue for pipeline stages with atomic lease claims |
| 4 | `supportemailairuns` | `SupportEmailAiRun` | `_id` | `{emailId: 1, createdAt: -1}`, `{inputHash: 1, promptVersion: 1, stage: 1}` | Audit trail of LLM classification and structured extraction calls |
| 5 | `supporttickets` | `SupportTicket` | `ticketNumber` (unique), `dedupeKey` (unique) | unique `ticketNumber`, unique `dedupeKey`, `{status: 1, createdAt: -1}`, `{assignedTo: 1, status: 1}`, `{category: 1, createdAt: -1}` | Core support ticket entity linked to student/counselor workflows |
| 6 | `supportticketevents` | `SupportTicketEvent` | `_id` | `{ticketId: 1, createdAt: -1}`, `{type: 1, createdAt: -1}` | Append-only audit timeline of ticket state and attribute mutations |
| 7 | `supportemailauditlogs` | `SupportEmailAuditLog` | `_id` | `{createdAt: -1}`, `{action: 1, createdAt: -1}`, `{targetId: 1, createdAt: -1}` | Administrative and security action logs |
| 8 | `supportemailwebhookevents` | `SupportEmailWebhookEvent` | `dedupeKey` (unique) | unique `dedupeKey`, `{receivedAt: -1}`, TTL `{expiresAt: 1}` (7 days) | Notification deduplication buffer for Graph webhooks |
| 9 | `emailsynccursors` | `EmailSyncCursor` | `{mailbox, folder}` (unique) | unique `{mailbox, folder}`, `{syncStatus: 1, syncLeaseExpiresAt: 1}` | Delta sync cursor, durable dirty flag (`hasPendingSync`), and atomic sync lease lock |
| 10 | `graphsubscriptions` | `GraphSubscription` | `subscriptionId` (unique) | unique `subscriptionId`, `{expirationDateTime: 1}` | Microsoft Graph webhook subscription renewal tracking |
| 11 | `googlesheetssyncjobs` | `GoogleSheetsSyncJob` | `{ticketId, spreadsheetId, tab}` (unique) | unique `{ticketId, spreadsheetId, tab}`, `{state: 1, nextAttemptAt: 1}` | Outbox projection queue for Google Sheets synchronization |
| 12 | `supportemailruns` | `SupportEmailRun` | `_id` | `{runKey: 1, startedAt: -1}`, `{startedAt: -1}` | Cron run execution ledger and heartbeat statistics |
| 13 | `emailingestionpolicies` | `EmailIngestionPolicy` | `mailbox` (unique) | unique `mailbox` | Activation boundary guard to prevent historical email ingest |
| 14 | `supportticketcounters` | `SupportTicketCounter` | `key` (unique) | unique `key` | Atomic sequence counter for human-readable ticket numbers |

---

## 3. Queue Architecture & Atomic Leases

### 3.1 Claim Protocol
Processing jobs are enqueued per email and stage (`fetch`, `attachments`, `ai`, `ticket`, `sheets`). To ensure no two concurrent workers ever execute the same job:
1. **Atomic Acquisition:** The worker executes `findOneAndUpdate` with a composite filter:
   ```javascript
   {
     $and: [
       stage ? { stage } : {},
       {
         $or: [
           { state: 'pending', nextAttemptAt: { $lte: now } },
           { state: { $in: ['claimed', 'processing'] }, leaseExpiresAt: { $lte: now } }
         ]
       }
     ]
   }
   ```
2. **Sort Strategy:** Jobs are claimed by `{ priority: -1, nextAttemptAt: 1, _id: 1 }`, ensuring high-priority requests drain first and starvation is avoided.
3. **Claim Token:** Each claim generates a fresh, collision-resistant `claimToken` (`crypto.randomUUID()`):
   ```javascript
   {
     $set: {
       state: 'claimed',
       claimedAt: now,
       claimedBy: workerId,
       claimToken,
       leaseExpiresAt: new Date(now.getTime() + leaseMs),
       updatedAt: now
     },
     $inc: { attempts: 1 }
   }
   ```
4. **Token Guarded Mutations:** Any subsequent operation (`startProcessingJob`, `renewLease`, `completeJob`, `releaseJob`, `failJob`) requires both `_id` AND `claimToken`. If a worker's lease expired and another worker reclaimed the job, the first worker's mutations will fail safely with `modified: false`.

### 3.2 Lease Recovery & Crash Resilience
If a worker crashes, encounters an unhandled exception, or is terminated by Vercel serverless execution timeout:
- Its `leaseExpiresAt` timestamp will naturally lapse (default lease: 120 seconds).
- The next scheduled cron tick or concurrent worker will reclaim the job via the `$or` query branch.
- Alternatively, `recoverStaleJobs()` systematically scans for expired leases and resets them to `pending` or transitions them to `dead_letter` if max attempts have been exceeded.

### 3.3 Retry Backoff & Dead-Letter Caps
- Stage-specific maximum attempt caps prevent infinite retry storms:
  - `fetch`: 6 attempts
  - `attachments`: 5 attempts
  - `ai`: 4 attempts
  - `ticket`: 5 attempts
  - `sheets`: 5 attempts
- When `job.attempts >= maxAttempts`, `failJob()` marks the job as `dead_letter`, populates `deadLetterAt` and `deadLetterReason`, and logs the error.
- Prior to reaching the cap, `failJob()` applies exponential or configured backoff, resetting the state to `pending` and setting `nextAttemptAt: new Date(now + backoffMs)`.

### 3.4 Mailbox Synchronization & Coalescing Engine
Collection-level notifications act as asynchronous wake-up signals for Microsoft Graph delta synchronization. The mailbox synchronization engine (`services/supportEmail/mailboxSyncService.js`) provides zero-data-loss synchronization guarded by atomic monotonic versioning:

1. **Monotonic Version Signaling (`signalMailboxSync`):**
   - Atomically executes MongoDB `$inc: { syncRequestVersion: 1 }` and marks `hasPendingSync = true`.
   - **Zero Clock Dependence:** Completely immune to wall-clock skew, NTP adjustments, millisecond quantization, or out-of-order caller timestamps.
   - Rapid bursts of concurrent webhook pings are serialized by MongoDB document-level locking, incrementing `syncRequestVersion` deterministically.
2. **Atomic Sync Lock (`acquireSyncLock`):**
   - Workers claim exclusive access using `findOneAndUpdate` on `{ syncStatus: { $in: ['idle', 'failed'] } }` OR `{ syncStatus: 'syncing', syncLeaseExpiresAt: { $lte: now } }`.
   - Generates a collision-resistant `syncLockToken` with a lease window (default: 60s).
   - If a sync worker crashes, the lease expires and any subsequent worker or cron tick seamlessly takes over.
3. **Coalesced Sync Loop with Zero-Loss Guarantees (`runCoalescedSync`):**
   - **Captured Request Version:** Before executing delta queries, the worker captures `capturedVersion = cursor.syncRequestVersion`.
   - **No Premature Clearing:** `hasPendingSync` is *never* cleared at the start of a pass. If a worker crashes or Graph times out during the pass, `syncRequestVersion` and `hasPendingSync` remain intact.
   - **Atomic Version Advancement (`advanceSyncCursor`):** Advances `deltaLink` and updates `lastSyncedVersion = capturedVersion`. In a single atomic MongoDB pipeline, it evaluates:
     `hasPendingSync: { $cond: { if: { $gt: ['$syncRequestVersion', capturedVersion] }, then: true, else: false } }`.
     If any signal arrived during the pass, `syncRequestVersion > capturedVersion` is guaranteed true, and `hasPendingSync` remains `true`.
   - **Atomic Guarded Release (`releaseSyncLockIfNoPending`):** When attempting to release the lock, the worker executes `findOneAndUpdate` with `{ syncRequestVersion: { $lte: capturedVersion }, hasPendingSync: false }`. If a signal arrived during the release check, release is refused and the worker loops immediately to execute another pass.
   - **Max Passes Limit Preservation:** If `maxPasses` is reached, the lock is freed to `'idle'`, `hasPendingSync` remains `true`, and an optional `scheduleFollowUpFn` hook is invoked.
4. **Independent Periodic Reconciliation (`checkPeriodicReconciliation`):**
   - Independent background cron heartbeat (every 10 minutes) checks `lastSuccessfulSyncAt`, `baselineCompletedAt`, and version gaps (`syncRequestVersion > lastSyncedVersion`).
   - Accurately classifies `no_cursor_baseline_needed`, `never_synchronized`, `pending_sync_flagged`, `periodic_stale_threshold_exceeded`, and `sync_fresh`.
   - Guarantees 100% email discovery even in the event of total Microsoft Graph webhook outages, firewall drops, or delayed delivery.

---

## 4. Guarded State Transitions

### 4.1 Queue Job State Machine

```
                   +------------+
                   |  PENDING   |<-------------------+ (Admin Replay)
                   +------------+                    |
                     |        |                      |
            claimJob |        | cancel               |
                     v        v                      |
      +--------------+      +-----------+            |
      |   CLAIMED    |      | CANCELLED |            |
      +--------------+      +-----------+            |
        |     |    |                                 |
  start | rel |    +--------------+                  |
        v     |                   |                  |
+------------+|                   |                  |
| PROCESSING || fail (max exceeded| fail (retry)     |
+------------+|                   |                  |
   |      |   |                   |                  |
   |      +---+-------------------+                  |
   |          |                   |                  |
   | complete |                   v                  |
   v          v            +-------------+           |
+-----------+            | DEAD_LETTER |-------------+
| COMPLETED |            +-------------+
+-----------+
```

### 4.2 Email Pipeline Stage States

1. **`fetch`:** `pending` -> `fetched` | `failed`
2. **`attachments`:** `pending` -> `processing` -> `extracted` | `partial` | `failed`
3. **`ai`:** `pending` -> `processing` -> `classified` | `needs_review` | `failed`
4. **`ticket`:** `pending` -> `linked` | `created` | `merged` | `failed`
5. **`sheets`:** `pending` -> `synced` | `failed` | `exhausted`

### 4.3 Derived Email Status
- **`failed`**: If `fetch` failed, `ticket` failed, or `sheets` is exhausted.
- **`needs_review`**: If `ai` flagged low confidence or JSON schema ambiguity (`needs_review` or `failed`).
- **`completed`**: All active stages reached terminal success (`fetched`, `extracted`/`partial`, `classified`, `created`/`linked`, `synced`).
- **`processing`**: Any stage is actively in progress.
- **`received`**: Initial ingestion state awaiting pipeline execution.

---

## 5. Deduplication & Identifier Normalization

1. **`graphMessageId`:** Immutable Microsoft Graph ID. Enforced by unique index on `supportEmails`.
2. **`internetMessageId`:** RFC 5322 identifier. Stripped of surrounding angle brackets (`<...>` -> `...`) and whitespace. Indexed via partial unique index (`{ internetMessageId: { $type: 'string', $gt: '' } }`), allowing missing or empty values while strictly rejecting duplicates.
3. **`buildWebhookDedupeKey`:**
   - **Message-Level Notifications (`/messages/{id}` or `resourceData.id`):** Deduplicated deterministically via `${subscriptionId}:${resource}:${resourceId}:${changeType}(:${timeBucket})`. Stored in `SupportEmailWebhookEvent` with a 7-day TTL index to absorb Graph delivery retries during bursts without re-processing.
   - **Collection-Level Notifications (`/mailFolders('inbox')/messages` without `resourceId`):** In Microsoft Graph, folder-level notifications do not provide message IDs. These are treated as **wake-up pings** ("new changes exist in collection"), not unique email records. They are NOT inserted into `SupportEmailWebhookEvent` under a unique constraint (which would permanently suppress all subsequent collection pings for 7 days). Instead, they route directly to `mailboxSyncService.signalMailboxSync()`, setting a durable dirty flag (`hasPendingSync = true`).
4. **`buildTicketDedupeKey`:**
   - If `conversationId` is present: `conv:${conversationId}`, ensuring replies to the same thread are automatically linked to the existing ticket regardless of elapsed time.
   - If `conversationId` is missing: `hash:${sha256(fromAddress + '|' + normalizedSubject)}:w${windowNumber}`, enforcing a fixed 7-day epoch bucket (`Math.floor(date.getTime() / (7 * 86400000))`). Enquiries with the exact same subject from the same sender within the same fixed 7-day bucket merge; enquiries in different 7-day buckets or across bucket boundaries create distinct tickets. (True rolling windows require a database state query; isolated deterministic keying uses fixed epoch buckets).
5. **`buildContentHash`:** Canonical SHA-256 hash of normalized sender address, normalized subject (ignoring `Re:`, `Fwd:`, whitespace), and attachment SHA-256 hashes to detect exact re-sends.

---

## 6. Ticket Number Generation Design & Justification

### 6.1 Design Justification
- **Student Usability:** Students reporting issues over phone or WhatsApp cannot reliably communicate 24-character ObjectIds (`67347a8c4f92bc31f9994c20`). A format like `GX-20261113-0001` is concise, human-friendly, and error-resistant.
- **Ops & CRM Visibility:** Support counselors and Google Sheets outboxes need a clean, sequential identifier.
- **Race-Free Concurrency:** Implemented via MongoDB's atomic `$inc` on `SupportTicketCounter` (`findOneAndUpdate` with `upsert: true, new: true`). Zero application-level distributed locks are required, achieving guaranteed unique, sequential numbers across parallel workers.
- **Daily Key Isolation:** Counters partition daily (`GX-YYYYMMDD`), preventing unbounded sequence numbers while naturally organizing tickets by date.

### 6.2 Format
```text
GX-YYYYMMDD-XXXX
Example: GX-20261113-0001, GX-20261113-0002, ...
```

---

## 7. Index Management & Safety Runbook

### 7.1 Dry-Run-First Migration Script
The migration script is located at `scripts/ensureSupportEmailIndexes.js`.
- **Default:** DRY-RUN mode. Lists planned indexes, compares them against existing collection indexes, and builds nothing without explicit intent.
- **Execute Flag:** `--execute` (or `-x`) required to build indexes.
- **Environment Safety Checks:**
  - `NODE_ENV === 'production'`: **Strictly refused**. Production index creation must be a supervised DBA step.
  - Remote Database URI: **Strictly refused**. The script checks `isLocalUri(uri)`. Remote clusters (Atlas) are rejected to prevent unmonitored index builds against production or shared staging clusters.
- **Duplicate Preflight Check:** Before executing any unique index creation, an aggregation pipeline scans the collection for duplicate keys. If duplicates exist, the script reports the offending keys and aborts immediately without applying the index.
- **Safe Operations:** Always uses `createIndexes`, never `syncIndexes` (which could accidentally drop operational indexes).

### 7.2 Runbook: Local Test Execution
```bash
# 1. Inspect planned indexes in dry-run mode
node scripts/ensureSupportEmailIndexes.js

# 2. Execute index creation against local MongoDB instance
node scripts/ensureSupportEmailIndexes.js --execute
```

### 7.3 Runbook: Production DBA Deployment Procedure
1. Verify cluster performance, IOPS headroom, and replication lag in MongoDB Atlas console.
2. Confirm zero duplicate keys exist on target unique index fields using Atlas aggregation or read queries.
3. Build indexes during off-peak maintenance window using Atlas UI, MongoDB Compass, or a supervised, approved migration runner with `commitQuorum: "majority"`.

