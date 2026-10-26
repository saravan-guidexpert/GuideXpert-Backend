# CRM Phase 10 — Final security verification and release readiness

Audit of the uncommitted working trees after Phase 9. No commit, push, deploy, production configuration change, or production database command was run. `syncIndexes()` was not run against any remote database. The assignment-index script was not executed against `.env` or any real database. No session cookie, reset token, database credential, or student record is recorded here.

- **Date:** 2026-10-25
- **Node:** v24.21.0
- **Verdict:** **NOT SAFE TO RELEASE**

## 1. Executive verdict

**NOT SAFE TO RELEASE**

Phase 9 closed the confirmed phone-update leak, the unscoped CRM student create, the sibling reset-token gap, the portal heartbeat gap, and the obsolete `pipelineStage` test. Those fixes held in isolated memory-server suites rerun for this audit.

Release is still blocked:

1. The active assignment unique index has not been confirmed on the real database. This audit proved, on an in-memory database with that index removed, that one revoke leaves the second active row in place and the user can still read the consultancy. Deploying the code does not create the index.
2. Production cookie flags, CORS, HTTPS, and the deployed frontend origin were not observed. The already-running local API is not in production cookie mode.
3. Both repositories' `HEAD` commits are not this working tree. Nothing from Phases 2–9 is on the tracked remote tips.
4. Login, refresh, back/forward, logout, and session expiry were not walked in a browser.

Passing automated tests are not production certification.

## 2. Scope and repository baseline

Parent folder `/Users/venkatesh/Guidexpert` is not a git repository. The two apps are separate clones. Both working trees were already dirty. This audit did not reset, clean, stash, or discard anything.

| Repository | Branch | HEAD | Tracking |
|---|---|---|---|
| `GuideXpert-Backend` | `feat/consultancy-crm-phase-1` | `c11c77144365be78b10f39909057739e5e0d491e` | `origin/feat/consultancy-crm-phase-1` (same commit) |
| `GuideXpert-Frontend` | `main` | `c1c30aba0f6ef99aa69b8c9a0b9ed900ed70b22f` | `origin/main` (same commit) |

HEAD messages, unchanged since Phase 8: backend “Merge main so CRM sign-in can ship with the current production API.” (2026-10-24 13:26:50 +0530). Frontend “Restore the CRM demo top bar with the company name and workspace controls.” (2026-10-24 16:27:17 +0530).

### What this audit changed

- `test/crmAssignment.test.js` — assigned inactive consultancy create, and one revoke while the unique index is absent.
- `docs/CRM_ASSIGNMENT_INDEX_RUNBOOK.md` — post-index authorization checks for the operator.
- This report.

No application service, route, or frontend behavior was edited in this phase. `package.json` and lockfiles were not modified. `npm audit` and the frontend build did not change them.

### Phase 9 files, separated from the earlier dirty tree

Phase 8's baseline already contained the multi-user CRM working tree. Phase 9 then edited security behavior inside some of those files and added the index procedure. This audit cannot reconstruct a byte-level split inside files that were already dirty before Phase 9. The Phase 9 behavior, confirmed by reading the current sources, is:

| Change | Files |
|---|---|
| Phone-conflict redaction on update | `services/crm/studentService.js`; assertions in `test/crmAssignment.test.js` |
| CRM student create requires an assigned consultancy | `services/crm/studentService.js`; `GuideXpert-Frontend/src/pages/crm-app/CrmPortalStudentsPage.jsx` |
| Sibling reset tokens invalidated in the password transaction | `services/crm/crmPasswordResetService.js`, `services/crm/crmAuthService.js`, `services/crm/crmUserAdminService.js`; `test/crmUserAuth.test.js` |
| Additive assignment index procedure, not executed on a real database | `scripts/ensureCrmAssignmentIndex.js`, `docs/CRM_ASSIGNMENT_INDEX_RUNBOOK.md`, `test/crmAssignmentIndex.test.js` |
| Portal heartbeats | `GuideXpert-Frontend/src/utils/crmSessionApi.js`, `src/utils/crmPresenceHeartbeat.js`, `src/pages/crm-app/CrmSessionContext.jsx` |
| `pipelineStage` test aligned to the current API | `test/crmPhase1.test.js` (`crmPhase1.test.js` was clean at the Phase 8 baseline) |

### Pre-existing dirty paths this phase did not edit

These were already dirty at the Phase 8 baseline and were left untouched by Phase 9 and by this audit:

- Backend: `controllers/jeeMainMockTestController.js` and the rest of the pre-Phase-9 CRM working tree (`server.js`, routes, models, activity, presence, operations, and the other modified services).
- Frontend: demo pages under `src/pages/crm-demo/`, platform Admin CRM pages including `src/pages/admin/crm/` and `src/pages/admin/JeeMainMockTestLeads.jsx`, `AdminLayout.jsx`, `vite.config.js`, and `index.html`.
- Untracked before Phase 9: `src/pages/admin/crm/workspace/`, `crmWorkspace.js`, and the earlier CRM docs audit `docs/CRM_MULTI_USER_PHASE1_AUDIT.md`.

No lockfile is modified in either repository.

### Secret scan of dirty and untracked files

Patterns checked: MongoDB URIs, private-key blocks, AWS access-key ids, JWT-shaped strings, and assigned secret-like literals. Matches were counted. Values were not printed.

- Backend source hit: one local example URI in a comment in `scripts/syncCrmIndexes.js` (`127.0.0.1`). Test files contain fixture passwords and in-memory URIs.
- Frontend source hit: the word `secret` inside a redaction regex in `src/utils/crmLoginFlow.js`. It is not a credential. Test files contain fixture passwords.
- No private key, cloud access key, or JWT-shaped production token was found in the dirty trees.

## 3. Findings

Severity is for the working tree as reviewed. “Verified” means an isolated test or a live unauthenticated probe ran in this phase. “Code review” means the current source was read and the suite that covers it passed, but a browser or production host was not used.

### P0 — Still open — High — Assignment index is not on the real database, and one revoke does not clear a duplicate

- **Files:** `models/CrmConsultancyAssignment.js` lines 18–21; `services/crm/crmAssignmentService.js` `revoke` lines 167–176 (`findOne` then save that one row); `config/mongooseSafety.js` forces `autoIndex` off for remote URIs; `scripts/syncCrmIndexes.js` refuses production and non-local URIs; `scripts/ensureCrmAssignmentIndex.js`.
- **Verified this phase:** With the partial unique index dropped on the memory server, a second assign returned `201`, one `DELETE` left one `revokedAt: null` row, and `GET` of that consultancy still returned `200` (`test/crmAssignment.test.js` line 619). With the index present, a duplicate assign is `409 duplicate_assignment` (existing assignment and operations tests). The index procedure tests passed against the memory server only.
- **Not verified:** Whether the real database has the index, has duplicate active pairs, or is a replica set.
- **Why it blocks release:** `assignedConsultancyIds` treats any remaining active row as access. Shipping assignment writes before the index exists recreates F-02.

### P0 — Requires production access — Production session and transport were not observed

- **Files:** `services/crm/crmCookies.js` lines 10–12 and 39–61 (`Secure` only when `NODE_ENV === 'production'`); `server.js` lines 125–153 (credentialed CORS; any `https://*.vercel.app`, any localhost port, and `http` or `https` on `guidexpert.co.in`); backend `vercel.json` sets `NODE_ENV` to `production`; frontend `vercel.json` rewrites `/api/:path*` to `https://gxp-new-backend.vercel.app/api/:path*` and sets no Content-Security-Policy.
- **Verified this phase, local process only:** An already-running API on port 5050 was probed without a login. This audit did not restart that process and does not claim it had loaded Phase 9.
  - `GET /api/crm-auth/me` with no cookie: `401`.
  - `GET /api/crm/students?page=1&limit=1` with no cookie: `401 authentication_required`, no `Set-Cookie`.
  - The same students URL with `Authorization: Bearer` and a non-session value: `401 authentication_required`.
  - `POST /api/crm-auth/login` from `Origin: https://evil.example`: `403 origin_forbidden`. Body keys were `code`, `message`, `success`.
  - `POST /api/crm-auth/logout` with no cookie: `200`. Clearing cookies were `Path=/`, `SameSite=Lax`. The session cookie was `HttpOnly`. The CSRF cookie was not. Neither cookie was `Secure`. No `Domain` attribute was present.
- **Not verified:** A production `Set-Cookie` over HTTPS, a cross-site credentialed request against the deployed host, or that the Vercel rewrite target is the process that will contain this code.

### Fixed and verified — F-01 phone update no longer returns another consultancy's student

- **Code:** `raisePhoneConflict` (`services/crm/studentService.js` lines 106–122) strips the payload when `assertStudentAccess` returns `not_found`. `updateStudent` uses it on the pre-check (lines 305–309) and on the duplicate-key catch (lines 342–344). The controller still sends `err.data` (`controllers/crmStudentController.js` lines 11–17). A redacted error has no `data` object, so the JSON `data` is null. Non-`CrmError` logs only `err.message`.
- **Verified:** Assignment suite. A manager assigned only to A `PATCH`es onto B's phone: `409 duplicate_student`. The body does not contain B's name, id, phone, email, city, or notes. Both stored phones stay unchanged. The same `PATCH` after B is soft-deleted does not contain B's id. An in-scope neighbour conflict may include that visible student, and the edited phone stays unchanged.
- **Limitation:** The duplicate-key catch uses the same function. The suite executed the pre-check. A concurrent cross-consultancy duplicate-key race was not run as its own case. In-scope conflicts still return the student the caller can already read. That is intended.

### Fixed and verified — F-04 CRM student create requires an assigned consultancy

- **Code:** `createStudent` throws `400 consultancy_required` for a CRM actor when no referral was requested, before insert (`studentService.js` lines 134–136). A supplied id goes through `assertConsultancyAccess` and `planNewReferral`. `planNewReferral` rejects an inactive consultancy with `409 consultancy_not_eligible` (`referralService.js` lines 97–106) before the student transaction. Platform admins are not CRM actors and can still insert without a consultancy.
- **Verified:** Missing id `400 consultancy_required`; malformed id `400 invalid_id`; unassigned id `404 not_found`; assigned inactive id `409 consultancy_not_eligible` with no student and no referral; assigned active id `201` with a referral and a later `GET` of `200`. Admin create without `consultancyId` is `201` and creates no referral. Counts were unchanged on the failing creates. Phase 1 still covers admin atomic rollback, including inactive source `consultancy_not_eligible` and forced audit failure.
- **Portal:** `CrmPortalStudentsPage.jsx` loads consultancies, disables submit until one is selected, and posts `consultancyId`. The admin student page and the demo store were not changed by Phase 9. Demo create-without-consultancy remains a demo-store rule, covered by the frontend demo tests.

### Fixed and verified — F-05 outstanding reset tokens are invalidated in the same transaction

- **Code:** `invalidateOutstandingResetTokens` (`crmPasswordResetService.js` lines 46–50) sets `usedAt` on every other unused row for that user. `resetPassword` calls it after a successful consume and before the password save and session bump (`crmAuthService.js` lines 267–276), inside `commitWithAudit`. Direct administrator password set does the same (`crmUserAdminService.js` line 478). Issuing a token does not invalidate the token just issued. `revokeSessions` still bumps the session version on a successful reset.
- **Verified:** `test/crmUserAuth.test.js` line 411. Two live tokens: first reset `200`, replay and the sibling `400 reset_invalid`, password changes once, both rows have `usedAt`. An expired token does not mark the other token used. Concurrent resets with two tokens: one `200`, one `400`, one `crm_user.reset_completed` audit. Forced audit failure leaves both tokens unused and the password unchanged. Direct password set marks a previously issued token used, and that token then fails. Existing single-token expiry, replay, and session-revocation tests still pass.
- **Limitation:** Login and forgot-password responses were not changed and stay generic aside from the inactive-account distinction in F-10.

### Fixed in code, not end-to-end verified — F-06 portal heartbeats

- **Code:** `crmHeartbeat` posts `{}` to `/crm-auth/heartbeat` (`crmSessionApi.js`). `crmFetch` attaches `x-crm-csrf` on non-GET requests. `CrmSessionProvider` starts `createPresenceHeartbeat` only while `status === 'ready'` and stops it in the effect cleanup (`CrmSessionContext.jsx` lines 31–36). The scheduler sends once, then every 60 seconds, skips a send while one is in flight, stops on `401`, and retries after `403` or a thrown network error.
- **Server, verified in the presence suite:** Heartbeat requires the CRM session and CSRF. A body that names another user or session is `400`. `expiresAt` does not change. A second immediate heartbeat does not rewrite `lastSeenAt` inside the write interval. The cap is in-process. Heartbeats are not audited.
- **Scheduler, verified in `crmPresenceHeartbeat.test.js`:** first send on start, no overlap, stop ignores a late `401` callback, a live `401` notifies once and stops, `403` and a thrown error do not.
- **Not verified:** A signed-in browser, `GET /api/crm-auth/presence` becoming `online`, or unmount in a real page.
- **New low finding, code review only:** `crmFetch` dispatches `gx-crm-unauthorized` on every `401` except login (`crmSessionApi.js` lines 52–54), including a heartbeat that returns after the scheduler has stopped. The scheduler test does not cover `crmFetch`. A heartbeat that was in flight at logout can clear a newer session if that old request returns `401` after the next login. Not demonstrated in a browser.

### Fixed and verified — F-13 pipelineStage contract test

`consultancyDTO` does not include `pipelineStage`. `updateConsultancy` writes name, notes, and status. `listConsultancies` returns `{ items, page, limit, total }`. The phase-1 test now expects no `pipelineStage` and no `pipeline` object, ignores `PATCH { pipelineStage: 'hot' }` without changing name or status, allows the stored schema default to remain `fresh`, and shows `pipelineStage=fresh` does not filter. Contacts, cross-consultancy contact `404`, pagination caps, search, and regex escaping in that test ran and passed. The schema default was not removed. That is a contract decision, not a security control.

### Still open — F-03 — Medium — Create and update still confirm that an out-of-scope phone exists

Out-of-scope conflicts return `409 duplicate_student` with the message that the number already exists and with `data: null`. The payload no longer contains the other student. The status and code still tell a user with `crm.students.create` or `crm.students.update` that the number is taken somewhere in the CRM. Phase 9 did not change that signal. It needs an owner decision: keep it and document it, or return a response that does not distinguish an unseen number from another conflict. Do not weaken the payload assertions while deciding.

### Still open — F-07 — Medium — Login and heartbeat limits are per process, and the app does not set `trust proxy`

`server.js` has no `trust proxy`. Confirmed by search. Account lockout remains on `CrmUser`. IP and heartbeat buckets are in-memory maps. This audit did not run a two-process spray or a forged `Forwarded` header. Production traffic shape is unverified.

### Still open — F-08 — Medium — The consultancy that loses a student loses the correction event

`businessAuditScope` (`auditService.js` lines 71–84) matches referrals and students by the referral's current `consultancyId`. It does not keep events whose `before.consultancyId` is the caller's consultancy. This audit did not add a new A-to-B activity assertion. Existing activity tests still pass for current-consultancy scope.

### Still open — F-09 — Low — Credentialed CORS allows a wide origin set

Source and the local `evil.example` probe match Phase 8. `SameSite=Lax` and a host-only cookie are why this is not treated as a demonstrated session theft. Production behavior was not tested. A production allow-list is still the right fix before `SameSite` or `Domain` is relaxed.

### Still open — F-10 — Low — Inactive login is distinguishable

Correct password on an inactive account remains `403 account_inactive`. Wrong password remains `401 invalid_credentials`. The auth suite still expects that. Not changed.

### Still open — F-11 — Low — Consultancy-create assignment audit drops the client IP

`consultancyService.js` lines 183–189 still pass `meta` into `writeAuthAudit`. `meta` is `{ ip, userAgent }`, not a request. The business audit above it stores `meta.ip` directly. Not changed.

### Still open — F-12 — Low — Operational limits

No TTL on expired sessions or used reset tokens, no upper bound on `page`, CRM auth routes share the 15 MB JSON limit, directory presence filtering loads matching users into memory, and an in-scope soft-deleted student can still be returned by detail. Not changed. No current service sets `deletedAt` during ordinary use; the phone test sets it directly.

### Not a vulnerability — F-14 — `crm.roles.manage` is module-wide

Unchanged design. Ordinary manager and viewer templates do not hold it. Global directory and assignment administration is that permission, not an IDOR for managers.

### Advisory, exploitability in CRM not demonstrated — F-15

`npm audit --json` on 2026-10-25, lockfiles unchanged. Exit status 1 because advisories exist. This audit did not build exploits and did not trace a CRM handler into the reported functions.

| App | Critical | High | Moderate | Low | Total |
|---|---|---|---|---|---|
| Backend | 2 | 10 | 3 | 0 | 15 |
| Frontend | 1 | 19 | 4 | 1 | 25 |

Critical package names from the audit metadata: backend `dompurify` and `proxy-addr` (both transitive); frontend `jspdf` (direct). Direct high or moderate packages also named: backend `axios`, `mongoose`, `multer`, `sharp`, `csv-parse`; frontend `dompurify`, `postcss`, `react-router-dom`, `vite`. Treat these as patch candidates. They are not confirmed CRM vulnerabilities.

### Confirmed on the local process only — F-16

The local logout cookies had no `Secure` attribute. Backend `vercel.json` sets `NODE_ENV=production` for Vercel. A host that starts `node server.js` without that variable would send the session cookie without `Secure`. The deployed `Set-Cookie` was not captured.

### Portal boundaries — code review plus isolated tests, browser not walked

- `/crm` renders `<Navigate to="/crm/login" />` (`App.jsx` line 562).
- `/crm/demo` mounts `CrmDemoLayout` outside `RequireCrmSession` and outside `ProtectedAdmin`. Legacy `/crm/<section>` paths redirect into `/crm/demo`.
- `/crm/app` is wrapped in `RequireCrmSession`, which redirects to `/crm/login?next=...` when the session is not `ready`.
- A search of `src/pages/crm-demo` and `src/utils/crmDemoStore.js` found no `fetch(`. Frontend tests assert demo operations do not call `fetch` and do not select the API client.
- CRM business routes use `requireCrmSession`, which reads only `gx_crm_session`. The live bearer probe and the operations suite both reject a platform Admin JWT as a CRM session. `GET /api/admin/crm/students` with no bearer returned `401` with `success: false` and no CRM `code`.
- Management routes use server permissions (`crm.roles.manage`, `crm.users.*`) or the admin section key. The assignment suite still rejects a manager or viewer assigning a consultancy (`403`).

These route facts were read from source and from the suites. This audit did not open a browser, so login, refresh, back/forward, and logout UI were not confirmed.

## 4. Tests executed

Isolated memory replica sets. No `.env` database. One command:

```text
node --test --test-concurrency=1 \
  test/crmPhase1.test.js \
  test/crmUserAuth.test.js \
  test/crmAssignment.test.js \
  test/crmActivity.test.js \
  test/crmPresence.test.js \
  test/crmOperations.test.js \
  test/crmAssignmentIndex.test.js
```

**Exit 0. 69 tests, 69 passed, 0 failed, 0 skipped.** About 23.4s.

| Suite | Result |
|---|---|
| CRM activity timeline | 3 passed |
| CRM consultancy assignment isolation | 8 passed |
| CRM assignment index procedure | 5 passed |
| CRM operations and directory | 4 passed |
| Consultancy CRM phase 1 | 26 passed |
| CRM session presence | 4 passed |
| CRM user authentication, plus the permission-map test | 19 passed |

The six CRM suites account for 64 passes. The index procedure accounts for the other 5. The two new assignment cases (inactive assigned create, and revoke without the unique index) passed in this run. No test was weakened.

Frontend, from `GuideXpert-Frontend`:

```text
npm test
```

**Exit 0. 117 tests, 117 passed, 0 failed.** About 0.35s. Includes demo fetch isolation, login redirect safety, workspace gating, and the four heartbeat scheduler tests.

```text
npx eslint src/utils/crmSessionApi.js src/utils/crmPresenceHeartbeat.js \
  src/utils/crmPresenceHeartbeat.test.js \
  src/pages/crm-app/CrmSessionContext.jsx \
  src/pages/crm-app/CrmPortalStudentsPage.jsx \
  src/pages/crm-app/RequireCrmSession.jsx src/App.jsx \
  src/utils/crmLoginFlow.js src/utils/crmDemoStore.js
```

**Exit 0.** No findings on those files.

```text
npx eslint .
```

**Exit 1. 322 errors, 46 warnings across 694 files.** CRM path filter (`crm-app`, `crm-demo`, `admin/crm`, `utils/crm`, `consultancyPipeline`): **0 errors, 0 warnings.** Same totals as the Phase 8 lint baseline. Pre-existing and not CRM-related. Not fixed.

```text
npm run build
```

**Exit 0.** Vite 7.3.1, 2903 modules, about 4.2s. Main chunk `dist/assets/index-B4Bgedye.js` is about 4.7 MB minified. Browserslist data is reported as 10 months old. No application source was changed to silence the chunk warning.

### Not run

| Check | Why |
|---|---|
| Backend `npm test` | That script is `test:whatsapp-all` (`test/*.test.js` plus WhatsApp integration suites). It is outside this CRM audit. It was not used as a release signal. |
| Browser login, refresh, back/forward, logout, expired session | Not performed. |
| Production HTTPS, cookies, CORS, and the real assignment index | Not contacted. |
| Restart of the local API | The process on port 5050 was already running. Probes were unauthenticated and are not evidence that the process loaded Phase 9. |

Phase 1's counsellor-student test passed inside the CRM command (`GET /api/counsellor/students` still returns only that counsellor's students). That is the Admin/counsellor regression included here. Demo regressions ran in the frontend suite.

## 5. Production-only checks that remain unverified

- The target database has `crmConsultancyAssignments` index `consultancyId_1_crmUserId_1`, unique, partial filter `{ revokedAt: null }`.
- Active assignment pairs are unique on that database before the index is created.
- The target MongoDB is a replica set, so `commitWithAudit` does not return `503 transaction_required`.
- The API process that will serve this code has `NODE_ENV=production`.
- A real login `Set-Cookie` for `gx_crm_session` includes `Secure`, `HttpOnly`, and `SameSite=Lax`, and omits `Domain`.
- The frontend rewrite host `gxp-new-backend.vercel.app` is that API.
- Login from the production site over HTTPS, including a cross-origin rejection for an unknown host.
- Browser session lifecycle on the deployed origin.
- Dependency advisories are reachable from a CRM or same-origin request.

## 6. Assignment-index rollout checklist

The procedure is `docs/CRM_ASSIGNMENT_INDEX_RUNBOOK.md` and `scripts/ensureCrmAssignmentIndex.js`. This audit read both and ran the memory-server tests. It did not connect the script to a real database.

Confirmed in the script and tests:

- Collection is only `crmConsultancyAssignments`.
- The process refuses to run unless `CRM_ASSIGNMENT_INDEX_APPLY=1`.
- `--database` must equal the database name in `MONGODB_URI`. The connected database name is checked again after connect.
- Duplicate active pairs (`revokedAt: null`, grouped by consultancy and user) print the pair count and assignment ids, exit non-zero, and do not create or alter an index.
- A same-key index whose `unique` flag or partial filter differs is left in place.
- An index that already matches key, `unique`, and `{ revokedAt: null }` is a no-op.
- The script does not call `syncIndexes()` and does not drop an index.
- Importing the module does not load `.env`.

The runbook now also tells the operator to check assign, duplicate assign, revoke, re-assign, and cross-consultancy `404` after the index exists, using accounts created for that check.

Operator checklist. Do not start until every box is true:

1. Written approval names this one index and this database. A general index sync is not approval.
2. A backup of that database exists and a restore has been rehearsed or explicitly accepted.
3. `MONGODB_URI` for the command is that database, and `--database` is its name. The operator compares the names before setting `CRM_ASSIGNMENT_INDEX_APPLY`.
4. Duplicate active pairs are resolved by hand. Prefer setting `revokedAt` on the extra row. Do not delete a row without a separate data approval. Do not drop the collection.
5. Command, from `GuideXpert-Backend`:

```bash
CRM_ASSIGNMENT_INDEX_APPLY=1 node scripts/ensureCrmAssignmentIndex.js --database <database-name>
```

6. Success output is either `Created crmConsultancyAssignments.consultancyId_1_crmUserId_1.` or `Assignment index already matches. No index was created or changed.`
7. Read the index back. Key `{ consultancyId: 1, crmUserId: 1 }`, `unique: true`, partial filter `{ revokedAt: null }`. No other index was dropped.
8. If the command prints duplicated pairs or an index mismatch, stop. Fix the data or the incompatible index by hand. Run the command again only after that approval.
9. Post-checks with non-production accounts: second active assign for the same pair is `409 duplicate_assignment`; revoke then read is `404`; a later assign is allowed because the old row is revoked; a user assigned only to A receives `404` for B.
10. Rollback of this change, if ever approved later, drops only `consultancyId_1_crmUserId_1`. It does not drop `crmConsultancyAssignments`. Dropping the index removes the guarantee this checklist just created.

This phase does not prove the real database has the index.

## 7. Remediation order

### P0 — release gates

1. Resolve duplicate active assignments on the target database, then run the approved index command. Do not enable assignment writes in production before step 9 of the checklist passes.
2. Confirm the target is a replica set and that `NODE_ENV=production` is set on the API host that will run this code.
3. Capture a production login `Set-Cookie` and an unknown-origin login rejection. Record flags only. Do not record the cookie value.
4. Commit and review both working trees. Deploying current `origin/feat/consultancy-crm-phase-1` or `origin/main` does not deploy this system.

### P1 — fix before calling the release safe

1. Change `revoke` so one revoke clears every active row for that user and consultancy. The index remains required. The memory-server test at `test/crmAssignment.test.js` line 619 shows why a single `findOne` is not enough when the index is missing.
2. Decide F-03. Document the `409 duplicate_student` existence signal, or stop distinguishing an unseen phone. Keep the payload redaction either way.
3. Stop a late heartbeat `401` from clearing a session that was created after that request started (`crmSessionApi.js` lines 52–54).
4. Move login and heartbeat rate limits to a shared store, and decide `trust proxy` only for the platform hop.
5. Restrict production CORS and the CRM origin check to the real frontend origins over `https`.
6. Walk `/crm`, `/crm/login`, `/crm/demo`, and `/crm/app` in a browser: refresh, back after logout, inactive user, and revoked session. Demo must not call `/api/crm`.

### P2 — after the release gates

1. F-08: keep a source-correction event visible to the consultancy that lost the student, without returning the student record.
2. F-10: if product policy requires a generic login error, return `401 invalid_credentials` for inactive accounts and keep the auth audit.
3. F-11: pass the request, not the prebuilt metadata object, into the consultancy-create auth audit.
4. F-12: TTL or retention for sessions and used reset tokens, a page cap, a smaller JSON limit on CRM auth, and database pagination for presence.
5. F-15: patch advisories on a dependency change of its own, with lockfile review. Do not treat the audit counts as confirmed CRM exploits.
6. Add a Content-Security-Policy. The CSRF cookie is readable by script on the frontend origin.
7. Frontend lint: 322 errors and 46 warnings are outside CRM paths. Fix them in a separate change. Do not block this security decision on them, and do not hide them.

## 8. Confirmation

This phase did not commit, push, deploy, change production configuration, or run a database migration. It did not run `syncIndexes()` against a remote database. It did not execute `scripts/ensureCrmAssignmentIndex.js` against a real `MONGODB_URI`. The local API probes did not log in and did not send a real password. The verdict remains **NOT SAFE TO RELEASE**.
