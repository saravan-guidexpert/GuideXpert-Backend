# GuideXpert Support Email Automation — Phase 2A: Microsoft Graph Authentication & Delta Sync Engine

## 1. Architecture Overview & Ingestion Semantics

Phase 2A implements the Microsoft Graph integration and incremental email ingestion engine for GuideXpert. It bridges the Phase 1 database foundation with Microsoft 365, establishing a resilient, fault-tolerant synchronization pipeline for inbound student and parent support enquiries.

### 1.1 Ingestion Semantics & Failure Boundaries
- **At-Least-Once Delivery Semantics:** Network retries, delta replays, and overlapping handoffs mean that individual emails may be delivered more than once to the ingestion layer.
- **Idempotent Ingestion & Deduplication:** Duplication is neutralized at the database layer via MongoDB unique indexes (`graphMessageId` unique and `internetMessageId` partial unique). Re-encountered messages are safely skipped (error code 11000), preventing duplicate tickets or processing jobs.
- **Strict Mailbox Scoping:** Enforces least-privilege access using modern Exchange Online RBAC for Applications, strictly isolating access to `support@niatindia.com` and forbidding tenant-wide Entra ID grants.
- **New-Only Boundary Guard:** Enforces `receivedDateTime >= activationAt` across all ingestion channels, marking historical emails as `isHistorical: true` and bypassing the downstream processing queues.
- **Crash-Resilient Pagination:** Persists `@odata.deltaLink` to `EmailSyncCursor` strictly upon complete, successful sync pass conclusion. If any page fails, the pass aborts immediately and the previous delta checkpoint is preserved.
- **Document Size Discipline:** Enforces payload bounding (100 KB plain text, 20 KB HTML snippet) and delegates raw attachment binaries to Phase 3 GridFS.
- **Physical & Transport Boundaries:** In the unfiltered delta baseline architecture, the engine synchronizes the Inbox folder change stream directly without artificial time-partitioned boundaries. Messages committing across Exchange Online transport servers while baseline enumeration is running are retrieved across pagination or delivered on subsequent incremental delta passes. Periodic reconciliation passes provide secondary resilience against network partitions.

---

## 2. Evaluation: Filtered Two-Phase Baseline vs Unfiltered Delta Baseline

### 2.1 The Core Problem: The 5,000-Item Filter Limitation
Microsoft's official documentation for message delta synchronization specifies:
> *"When a filter is applied to a delta query on messages, Microsoft Graph returns at most 5,000 messages matching the filter. Once 5,000 messages have been returned across pagination, Graph issues an `@odata.deltaLink` and terminates the initial sync."*
> — *[Microsoft Graph Delta Query Messages Documentation](https://learn.microsoft.com/en-us/graph/delta-query-messages)*

Furthermore:
- The only supported `$filter` expressions on `/messages/delta` are `receivedDateTime ge {value}` and `receivedDateTime gt {value}`.
- Bounded time-window partitioning (e.g. `$filter=receivedDateTime ge A and receivedDateTime le B`) is rejected with HTTP 400 `ErrorInvalidUrlQuery`.
- Delta tokens cannot be merged across independent queries.
- Official references:
  - [Microsoft Graph mailFolder: delta API reference](https://learn.microsoft.com/en-us/graph/api/mailfolder-delta-messages?view=graph-rest-1.0)
  - [Microsoft Graph Delta Query Overview](https://learn.microsoft.com/en-us/graph/delta-query-overview)
  - [Get incremental changes to messages (Delta Query)](https://learn.microsoft.com/en-us/graph/delta-query-messages)
  - [Outlook Immutable Message Identifiers](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)

### 2.2 Unfiltered Delta Queries: Paginated Sequence Without Filter Cap
Crucially, Microsoft Graph's documentation and operational semantics establish that:
1. **The 5,000-message cap applies strictly when `$filter` is present on `/messages/delta`.**
2. **When NO `$filter` parameter is applied (`GET /users/{id}/mailFolders/{id}/messages/delta`), the 5,000-item limit does NOT apply.**
   Graph delivers the folder state using paginated `@odata.nextLink` responses until the baseline synchronization is complete, at which point it issues the official `@odata.deltaLink`.
3. **Operational Reality (Not "Unlimited"):** Unfiltered delta is not infinite or unmetered. It is bounded by standard HTTP timeouts, server page sizes (typically 10–250 items per page), Graph throttling limits (HTTP 429), and transient network errors. Our client handles these with exponential backoff and monotonic cursor leases.

### 2.3 Architectural Comparison

| Dimension | Strategy 1: Filtered Two-Phase Baseline | Strategy 2: Unfiltered Delta Baseline (Recommended) |
|---|---|---|
| **API Endpoints** | Two APIs: standard `/messages` (Catch-Up) + `/messages/delta?$filter=...` (Attachment) | A single unified API: `/messages/delta` for baseline and incremental sync |
| **5,000 Truncation Risk** | **High.** If filtered delta attachment query ever encounters $\ge 5,000$ messages, Graph terminates prematurely. Requires dynamic overlap shrinking and hard truncation guards. | **Not subject to filter cap.** Unfiltered delta queries do not apply Microsoft's 5,000-message filter limit. However, mailbox size and request latency remain governed by Graph rate limits (HTTP 429), gateway timeouts, and pagination volume. |
| **Handoff Race Conditions** | **Complex & Vulnerable.** Requires bridging two separate APIs, managing timestamp intervals, clock skew, asynchronous transport commits, identical timestamps, and pagination gaps. | **Eliminated by unified query.** The delta stream itself serves as the baseline, avoiding handoff gaps between disparate list and delta endpoints. Messages arriving mid-query are captured on subsequent pages or passes. |
| **Transport Commit Delay** | Can omit messages whose commit was delayed beyond the overlap window. | **High resilience.** Because the query traverses the folder state rather than a narrow timestamp window, committed messages are enumerated regardless of minor transport delays, with subsequent delta passes catching late-committing items. |
| **Activation Guard** | Dual enforcement: API `$filter` + local ingestion check. | Local ingestion enforcement: messages prior to `activationAt` are marked `isHistorical: true` and strictly bypass all queues and tickets. |
| **Performance on Clean/New Mailbox** | Fast (~100 ms). | Fast (~100 ms). For a newly provisioned support mailbox (`support@niatindia.com`), only existing items are enumerated. |
| **Large Mailbox Trade-Off (100k+ Old Emails)** | Skips old historical years via API date filter. | Must paginate through all historical items in the Inbox once during initial baseline. |
| **Crash Recovery** | Restarts catch-up from `activationAt` or last checkpoint; duplicates skipped via code 11000. | Restarts unfiltered delta query; duplicates skipped via code 11000. Commits `deltaLink` only on complete pass. |

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 RECOMMENDED: UNFILTERED DELTA BASELINE                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
             GET /users/{mailbox}/mailFolders/inbox/messages/delta
             (Strictly NO $filter parameter!)
                                      │
                     ┌────────────────┴────────────────┐
                     │ Follows paginated @odata.nextLink│
                     │ No 5,000-message filter cap!     │
                     │ Ingests messages to MongoDB     │
                     └────────────────┬────────────────┘
                                      │
                                      ▼
             Local Activation Boundary Enforcement
             ├── receivedDateTime < activationAt:
             │     Mark isHistorical: true, pipeline: completed
             │     * NEVER enqueued to processing jobs
             │     * NEVER creates support tickets
             │
             └── receivedDateTime >= activationAt:
                   Mark isHistorical: false, pipeline: received
                   * Enqueued for fetch stage processing
                                      │
                                      ▼
             Final page returns official @odata.deltaLink
                                      │
                                      ▼
             Persist deltaLink in EmailSyncCursor
             (Subsequent runs execute lightweight incremental sync)
```

### 2.4 Remaining Data-Loss Risks & Real-World Considerations
While the Unfiltered Delta Baseline eliminates handoff race conditions, real-world distributed architectures carry operational considerations:
1. **Initial Sync Duration on Existing High-Volume Mailboxes:** If `support@niatindia.com` contains 100,000+ historical emails, the initial unfiltered sync must paginate through all pages. Under Graph rate limits (~4–5 requests/sec), this initial pass may take 5–10 minutes. Our atomic lease model and `GraphClient` exponential backoff safely accommodate this.
2. **Network Interruptions during Baseline:** If a network interruption aborts the baseline on page 50 of 100, the cursor's `deltaLink` remains `null`. The subsequent run restarts from page 1. MongoDB unique indexes (`graphMessageId`) catch already-ingested messages (code 11000), guaranteeing zero duplicate records or jobs.
3. **Delta Token Invalidation & Resync Triggers (HTTP 410, syncStateNotFound):** Microsoft Graph does not guarantee a fixed lifetime (such as 7 days) for delta tokens. Delta tokens may be invalidated at any time due to internal Exchange maintenance, mailbox migrations, mailbox restorations, or token expiration. When Graph returns HTTP 410 (`Gone`), error code `syncStateNotFound`, `ErrorDeltaTokenExpired`, or `resyncRequired`, the system discards the expired cursor and executes a fresh, clean baseline pass. Already-ingested records are preserved without re-enqueuing or creating duplicate tickets.

### 2.5 Change Tracking: @removed Events & Outlook Message ID Semantics
Microsoft Graph delta queries emit change events for modified and removed items:
1. **Removed Messages (`@removed`) & Official Graph Behavior:**
   - **Microsoft Graph Semantics:** Official Microsoft Graph documentation specifies that when an item leaves a synchronized folder (either because it was moved out of the folder to Archive/Trash/another folder, OR because it was permanently deleted), Microsoft Graph returns an item with an `@removed` property whose `reason` value is `deleted`. Graph does **not** provide a distinct `moved` reason.
   - **Indistinguishability in Delta Stream:** The delta removal event alone cannot reliably distinguish whether a message was moved out of the folder or permanently deleted from Exchange Online.
   - **Data Model & Ingestion Rules:**
     - The raw Graph removal reason is preserved in `metadata.graphRemovalReason` (e.g. `'deleted'`).
     - The engine does **not** speculate or infer `moved` from a Graph reason of `deleted`.
     - The message is recorded as no longer present in the synchronized folder: `metadata.isRemoved: true` and `metadata.inInbox: false`.
     - `metadata.removedAt: new Date()` records the application wall-clock time when GuideXpert **first observed** the removal event. Microsoft Graph does not provide an Exchange-side deletion timestamp in `@removed`.
     - **Replay Idempotency:** On repeated removal notifications or replay passes, `metadata.removedAt` is preserved and not overwritten.
     - **Explicit Representation of Missing / Malformed Data:** If `@removed` lacks a reason (`@removed: {}`), it is explicitly recorded as `graphRemovalReason: 'missing'`. If the reason property is malformed (`@removed: true`, `@removed: { reason: null }`), it is explicitly recorded as `graphRemovalReason: 'malformed'`. The engine **never** defaults unverified, missing, or malformed removal events to `'deleted'`.
   - **System-of-Record Protection:** In GuideXpert, `SupportTicket` and `SupportTicketEvent` records are immutable compliance records. A removed email in Outlook **NEVER** deletes or mutates the associated ticket or audit log in GuideXpert. The `SupportEmail` document in MongoDB is retained for historical traceability.
2. **Investigation of Outlook Message ID Behavior & Folder Moves:**
   - **Ordinary Graph Message IDs are Folder-Relative:** Under standard Microsoft Graph message IDs, message identifiers change whenever an item is moved to another folder. If an email is moved from `Inbox` to `Archive`, Exchange Online generates a new ID in the destination folder and the old ID ceases to exist.
   - **Unsupported 404 vs 200 Deletion Inference:** Because ordinary message IDs expire upon folder move, making a secondary request `GET /users/{mailbox}/messages/{graphMessageId}` using the old ID will return **HTTP 404 (Not Found)** even when the message still exists in another folder. Therefore, assuming that HTTP 404 proves permanent deletion is invalid and unsupported under ordinary message IDs.
   - **Evaluation of Immutable IDs (`Prefer: IdType="ImmutableId"`):**
     Microsoft Graph supports immutable message identifiers via the `Prefer: IdType="ImmutableId"` request header ([Outlook Immutable ID Documentation](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)). An immutable ID remains constant when messages are moved across folders in the same mailbox.
     However, adopting immutable IDs requires complete, end-to-end alignment across every Graph component:
     - Delta baseline and pagination queries
     - Incremental delta queries
     - Single message and body retrieval
     - Attachment downloads
     - Phase 2B webhook subscriptions (the subscription creation payload must specify the immutable ID header so notification payloads contain matching IDs)
     - `translateExchangeIds` cannot reliably translate IDs for messages that have already moved.
     **Architectural Decision for Phase 2A:** Existing standard message identifiers are retained. Speculative out-of-band folder-move inferences are removed. GuideXpert safely tracks that the message has left the Inbox (`inInbox: false`), preserving tickets and conversation threads as immutable systems of record.
3. **Read/Unread Updates:**
   - When an email's read state changes in Outlook, Graph emits the message in the delta feed.
   - In MongoDB, this hits error code 11000 (duplicate key on `graphMessageId`).
   - The ingestion service catches code 11000, updates `metadata.isRead` on the existing `SupportEmail` document, and strictly suppresses duplicate pipeline jobs and duplicate tickets.

---

## 3. Issue B: Microsoft 365 Mailbox-Scoped Permission Architecture

### 3.1 Security Boundary & Deprecation of Legacy Access Policies
Legacy integrations rely on granting `Mail.Read` in Microsoft Entra ID (Azure AD) and attempting to restrict access using `New-ApplicationAccessPolicy`.
- `New-ApplicationAccessPolicy` is legacy technology that Microsoft is phasing out in favor of Exchange Online RBAC for Applications.
- Under the legacy model, the application token is issued with broad tenant-wide `Mail.Read` scope by Entra ID. The restriction is enforced purely as a post-filter by Exchange.
- If the policy is deleted, misconfigured, or delayed in directory replication, the application immediately possesses full read access to all organizational mailboxes.

> [!WARNING]
> **Intended Architecture vs. Actual Administrator-Verified Posture:**  
> The PowerShell commands below define the intended target architecture. The GuideXpert engineering audit has **not** executed commands in the live production Exchange tenant and cannot verify actual tenant configuration without live administrative evidence. The live mailbox must **not** be claimed or assumed to be scoped or secure until a designated Exchange Administrator executes this runbook and verifies both positive and negative authorization tests.

### 3.2 Target Mailbox
- **Primary SMTP Address:** `support@niatindia.com`

### 3.3 Corrected Production PowerShell Deployment Runbook

Run the following commands in an elevated PowerShell session with Exchange Administrator privileges:

```powershell
# 1. Connect to Exchange Online PowerShell
Connect-ExchangeOnline -UserPrincipalName admin@niatindia.com -ShowBanner:$false

# 2. Define Variables
$AppId = "<YOUR_ENTRA_APP_CLIENT_ID>"                 # Application (Client) ID GUID from Entra App Registration
$EnterpriseAppObjectId = "<ENTERPRISE_APP_OBJECT_ID>" # Object ID GUID of the Enterprise Application (Service Principal) in Entra
$MailboxAddress = "support@niatindia.com"
$ScopeName = "GuideXpert-Support-Mailbox-Scope"
$RoleAssignmentName = "GuideXpert-SupportEmail-Read-Assignment"
$DisplayName = "GuideXpert-SupportEmail-Engine"

# 3. Create Exchange Online Service Principal linked to Entra Enterprise Application
# IMPORTANT: -ObjectId MUST be the Enterprise Application Object ID in Entra, NOT the App Registration Object ID!
Write-Host "Creating Exchange Service Principal for AppId: $AppId"
New-ServicePrincipal -AppId $AppId -ObjectId $EnterpriseAppObjectId -DisplayName $DisplayName

# 4. Create Management Scope restricted strictly to support@niatindia.com
Write-Host "Creating Management Scope for mailbox: $MailboxAddress"
New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter "PrimarySmtpAddress -eq '$MailboxAddress'"

# 5. Assign 'Application Mail.Read' role using -CustomResourceScope
# CRITICAL CORRECTION: For Exchange application roles, -CustomResourceScope MUST be used (NOT -CustomConfigurableWriteScope)
Write-Host "Assigning Application Mail.Read role to Service Principal..."
New-ManagementRoleAssignment -Name $RoleAssignmentName `
    -App $DisplayName `
    -Role "Application Mail.Read" `
    -CustomResourceScope $ScopeName

# 6. Verify Authorization against Target Support Mailbox (Must Return Authorized: True)
Write-Host "Verifying authorization against target mailbox..."
Test-ServicePrincipalAuthorization -Identity $DisplayName -Resource $MailboxAddress
# Expected outcome: Authorized: True

# 7. Verify Negative Authorization (MUST FAIL against all unauthorized mailboxes)
Write-Host "Verifying negative authorization against unauthorized mailbox..."
Test-ServicePrincipalAuthorization -Identity $DisplayName -Resource "ceo@niatindia.com"
# Expected outcome: Authorized: False / Access Denied
```

### 3.4 Mandatory Security Boundary: Entra ID API Permissions
> [!CAUTION]
> **What `Test-ServicePrincipalAuthorization` Actually Checks:**  
> `Test-ServicePrincipalAuthorization` evaluates **only** Exchange Online RBAC role assignments. It does **not** evaluate permissions granted in Microsoft Entra ID (Azure AD)!  
> If an administrator consented to tenant-wide `Mail.Read` in the Entra ID portal under API Permissions, Entra issues OAuth tokens containing the broad `roles: ["Mail.Read"]` claim. Under Microsoft Graph authorization rules, an Entra tenant-wide consent takes precedence, completely bypassing Exchange Online RBAC scoping.  
>  
> **Mandatory Rule:** In the Microsoft Entra ID portal, under the App Registration for GuideXpert, ensure that **NO Microsoft Graph Application Permissions (`Mail.Read`, `Mail.ReadWrite`, `Mail.Send`) have been granted administrator consent**. The permissions list must show zero application permissions consented.

### 3.5 Graph Authentication Code Permission Assumptions
Inspection of `services/supportEmail/graphAuthService.js`:
- `GraphAuthService` executes standard OAuth 2.0 client credentials grant using `scope: https://graph.microsoft.com/.default`.
- The client code makes **zero permission assumptions** and does not inspect token claims or enforce authorization locally.
- Enforcement relies entirely on Microsoft Graph and Exchange Online server-side authorization. If broad Entra consent exists, Graph allows reading any mailbox; if Exchange RBAC is configured and Entra application permissions are revoked, Graph allows reading only `support@niatindia.com`.

---

## 4. Issue C: Recovery Lifecycles & Operational Prerequisites

### 4.1 Separate Recovery Lifecycles: Baseline vs Delta-Link

| Recovery Phase | Trigger Scenario | State at Entry | Recovery Mechanism & Guarantee |
|---|---|---|---|
| **Baseline Recovery** | Worker crash, network drop, or server restart during initial catch-up or handoff. | `EmailSyncCursor.deltaLink === null` | Next worker restarts baseline. All messages already committed to MongoDB by previous worker are safely skipped via unique index (code 11000). Catch-up runs to completion, delta attaches, and `deltaLink` is committed. |
| **Delta-Link Recovery** | Graph returns HTTP 410 Gone / `syncStateNotFound` / `ErrorDeltaTokenExpired` / `resyncRequired`. | `EmailSyncCursor.deltaLink` exists but has been invalidated. | System catches resync error codes, resets `deltaLink: null`, and executes a fresh, clean baseline pass. Already-ingested messages are idempotently skipped (code 11000) without re-enqueuing or creating duplicate tickets. |

### 4.2 Operational Prerequisites Before Phase 2B
1. **Entra ID App Registration:** Client credentials configured with secret. Confirmed that **zero** application permissions are consented in Entra ID.
2. **Exchange Online RBAC Runbook:** Executed by tenant administrator with `-CustomResourceScope`, verified with `Test-ServicePrincipalAuthorization`.
3. **Mailbox Provisioning:** Target mailbox `support@niatindia.com` provisioned, licensed, and active.
4. **Environment Variables:**
   - `MS_GRAPH_TENANT_ID`: Azure AD Tenant GUID
   - `MS_GRAPH_CLIENT_ID`: Entra App Client ID GUID
   - `MS_GRAPH_CLIENT_SECRET`: App client secret
   - `MS_GRAPH_BASE_URL`: `https://graph.microsoft.com/v1.0`
5. **Database Indexes:** Verified using `node scripts/ensureSupportEmailIndexes.js` (dry-run preflight).
6. **Policy Initialization:** `EmailIngestionPolicy` document created with `mailbox: "support@niatindia.com"`, `enabled: true`, and explicit `activationAt`.

### 4.3 Remaining Production Security Gates & Blockers
- **Gate 1:** Execution of Phase 2B (Webhook subscription and route `/api/webhooks/graph`).
- **Gate 2:** Pre-production staging tenant verification using live Graph API credentials against real Exchange test mailboxes (verifying token refresh, rate limits, and live RBAC scoping).
- **Gate 3:** Formal index migration execution on production MongoDB Atlas (`--execute`).
- **Gate 4:** Administrative sign-off confirming zero tenant-wide Entra `Mail.Read` grants.

---

## 5. Verification & Test Metrics

> [!NOTE]
> **Testing Environment Distinction:** All tests listed below are executed using local in-memory MongoDB instances (`mongodb-memory-server`) and mock HTTP adapters simulating Graph API and Azure AD responses. They verify algorithmic correctness, concurrency safety, deduplication, and boundary guards. They do **not** replace staging tenant validation against live Microsoft Graph endpoints.

### 5.1 Test Suite Breakdown
- **Unfiltered Delta Baseline & Recovery Suite (`test/supportEmailUnfilteredDelta.test.js`):** 35 passing tests.
- **Two-Phase & Graph Integration Suite (`test/supportEmailGraph.test.js`):** 29 passing tests.
- **Core Support Email Foundation Suites (Models, Queue, Dedupe, State Machine, Cursors, Script):** 61 passing tests across 8 suites.
- **Existing System Regression Suites (WhatsApp, CRM, Gupshup):** 49 passing tests across 3 test files (28 in `whatsappRetryRules`, 11 in `gupshupWebhookFlow`, 10 in `demoMeetLiveWindows`).
  - *Reconciliation Note:* The previous report reported 47 existing tests due to two subtests in `whatsappRetryRules` being obscured in truncated terminal logs. Running the suite directly confirms exactly 49 existing regression tests.
- **Total Test Count:** **174 tests passing** across 27 suites (`0` failures, `0` skipped).

### 5.2 Unfiltered Delta Test Coverage (35 Scenarios)
1. `unfiltered baseline: >5,000 historical messages are paginated without 5,000 truncation and bypass queue`
2. `unfiltered baseline: >5,000 new messages after activation are ingested and enqueued`
3. `unfiltered baseline: historical messages strictly bypass queue while new messages are enqueued`
4. `unfiltered baseline: new messages arriving during initial delta pagination are captured`
5. `unfiltered baseline: multiple messages with identical receivedDateTime values are preserved`
6. `unfiltered baseline: messages becoming visible out-of-order after earlier page are captured`
7. `unfiltered baseline: crash during pagination and successful restart leaves cursor intact`
8. `unfiltered baseline: failure before deltaLink persistence leaves cursor null for safe replay`
9. `unfiltered baseline: deltaLink persistence happens strictly after complete pagination`
10. `unfiltered baseline: duplicate messages across repeated baseline runs are safely deduplicated`
11. `unfiltered baseline: deleted or moved messages (@removed) are handled safely`
12. `unfiltered baseline: stale worker with expired lease cannot advance deltaLink`
13. `unfiltered baseline: concurrent sync signals coalesce seamlessly during baseline execution`
14. `@removed: message removal from Inbox updates metadata and inInbox: false without deleting ticket or audit history`
15. `@removed: message moved out of Inbox arrives with reason deleted; system sets inInbox: false without inferring moved`
16. `@removed: permanently deleted message arrives with reason deleted; system sets inInbox: false and preserves SupportEmail`
17. `@removed: malformed and missing removal reasons are represented explicitly without defaulting to deleted`
18. `@removed: replayed removal events are idempotent and preserve original removedAt timestamp`
19. `@removed: removal event replay after rebaseline does not duplicate jobs or mutate tickets`
20. `delta updates: read/unread status updates in delta stream update metadata.isRead with zero duplicate jobs`
21. `recovery: syncStateNotFound triggers clean rebaseline without reusing old cursor`
22. `recovery: nested innerError code syncStateNotFound triggers clean rebaseline and preserves original selectFields`
23. `recovery: rebaseline after delta token invalidation produces zero duplicate processing jobs or tickets`
24. `normalizeGraphMessage: explicit missing and malformed @removed reason handling`
25. `activation boundary: exact boundary timestamps, historical exclusion, and strict rejection of missing/malformed timestamps`
26. `message identity: message moved out of Inbox and returned with new ordinary Graph ID does not duplicate tickets`
27. `concurrency: concurrent ingestion requests for identical email resolve safely without duplicate tickets`
28. `poison-message: one malformed message among valid messages is quarantined without blocking sync or advancing cursor prematurely`
29. `poison-message: multiple malformed messages in a page are all quarantined while valid messages ingest`
30. `poison-message: crash after recording validation failure before cursor advancement retries idempotently without duplicate quarantine logs`
31. `poison-message: replay of the same invalid message does not create duplicate quarantine records`
32. `poison-message: database failure while recording quarantine record aborts sync and prevents cursor advancement`
33. `deduplication: missing and empty internetMessageId values bypass partial unique index without collision`
34. `deduplication: duplicate-key error 11000 from an unexpected index is strictly rethrown rather than assumed an email duplicate`
35. `deduplication: concurrent ingestion of returning message with new Graph ID safely restores inInbox with zero duplicate jobs`

---

## 6. Immutable ID Architectural Decision Before Phase 2B

### 6.1 Architectural Decision: Retain Ordinary Graph IDs
**Explicit Decision:** GuideXpert will **retain ordinary Graph IDs** for Phase 2A and Phase 2B.

### 6.2 Decision Rationale
1. **Proven RFC 5322 Message-ID Restoration:** The partial unique index `internetMessageId_1_unique_partial` already provides mathematical deduplication when messages move between folders and return to the Inbox with new ordinary Graph IDs (validated in tests 26 and 35).
2. **Zero In-Flight ID Conversion:** Existing database records, indexes, and delta tokens remain homogeneous without requiring complex data migrations or split-brain schema adaptations.
3. **Safe URL Segment Handling:** Immutable IDs use Base64 encoding containing characters like `/` and `+` that can cause URL path segment truncation or double-encoding issues unless strictly percent-encoded across all HTTP adapters. Ordinary Graph IDs are URL-safe.

### 6.3 Immutable ID Specification (If Adopted in Future)
If the project subsequently chooses to adopt Immutable IDs in Phase 2B or Phase 3, the following uniform specification must be applied across all endpoints without mixing formats:
- **Default Client Header:** Every request issued by `GraphClient` must include `Prefer: IdType="ImmutableId"`.
- **Initial Delta Baseline & Incremental Delta:** Delta query requests transmit the `Prefer` header; Graph emits immutable IDs in `@odata.nextLink`, `@odata.deltaLink`, and message item bodies.
- **Message & Attachment Retrieval:** `GET /users/{id}/messages/{immutableId}` and `GET /users/{id}/messages/{immutableId}/attachments` must include `Prefer: IdType="ImmutableId"` and URL-encode the ID.
- **Webhook Subscriptions:** `POST /subscriptions` must include the header `Prefer: IdType="ImmutableId"`.
- **Webhook Notifications:** Notification validation and resource processing query the resource using the immutable ID.
- **Database Migration:** Existing `SupportEmail.graphMessageId` entries must be migrated via Graph translation endpoint (`POST /users/{id}/translateExchangeIds`) or a clean rebaseline must be performed. Mixed ID formats are strictly forbidden.
