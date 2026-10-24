# Phase 11 — CRM critical security remediation

Verdict: **not safe to release.** The five code fixes below are in the working tree and covered by automated tests. They do not prove the production assignment index, production HTTPS cookies, deployed CORS, or the browser session lifecycle.

No commit, push, deployment, production configuration change, `syncIndexes()`, assignment-index migration, or production database command was run.

## Baseline

- Backend: branch `feat/consultancy-crm-phase-1`, HEAD `c11c77144365be78b10f39909057739e5e0d491e`. The tree was already dirty from earlier CRM work. Those changes were left in place.
- Frontend: branch `main`, HEAD `c1c30aba0f6ef99aa69b8c9a0b9ed900ed70b22f`. The tree was already dirty. Demo pages, admin CRM pages, and unrelated edits were not modified for this phase.

## 1. Assignment revocation

**Issue.** `revoke` loaded one active `crmConsultancyAssignments` row and saved that row. Authorization treats any `revokedAt: null` row as access. Without the unique partial index, a second active row for the same user and consultancy stayed active after a successful revoke.

**Change.** `services/crm/crmAssignmentService.js` loads every active row for that exact `(consultancyId, crmUserId)` pair inside the existing required transaction, stamps the same `revokedAt`, and writes one `crm_assignment.revoked` auth audit. The audit `before.activeCount` and `after.revokedCount` record how many rows that transaction revoked. A second revoke finds no active row and returns `404 not_found`. A failed audit rolls the revocations back with the transaction.

A concurrent insert of a new document can still commit beside an in-flight revoke when the unique index is absent. Snapshot isolation does not turn that insert into an update of the rows being revoked. The partial unique index remains required. The runbook post-check now says revoke clears every active row for the pair and that the index is still what stops a second active insert.

**Files.** `services/crm/crmAssignmentService.js`, `test/crmAssignment.test.js`, `docs/CRM_ASSIGNMENT_INDEX_RUNBOOK.md`.

## 2. Stale heartbeat unauthorized events

**Issue.** `crmFetch` dispatched `gx-crm-unauthorized` for every `401` except login. A heartbeat that started before logout could return after the next login and clear the new session. The scheduler already ignored a `401` after `stop`, but the window event did not.

**Change.** `src/utils/crmSessionGuard.js` keeps a session epoch. The epoch advances when the CSRF key changes and when logout calls `retireCrmSession()` before the logout request. `crmFetch` records the epoch before `fetch` and dispatches `gx-crm-unauthorized` only when that epoch is still current. A current-session `401` still logs the user out. A `401` from `/crm-auth/login` does not. `403` and network failure do not. The 60-second interval, CSRF header, and the server rule that a heartbeat does not extend `expiresAt` are unchanged.

Logout retires the epoch without clearing the CSRF token first, so the logout request can still send `x-crm-csrf`.

**Files.** `GuideXpert-Frontend/src/utils/crmSessionGuard.js`, `src/utils/crmSessionGuard.test.js`, `src/utils/crmSessionApi.js`, `src/pages/crm-app/CrmSessionContext.jsx`.

## 3. Production CORS and origin checks

**Issue.** `server.js` and `utils/crmOrigin.js` each allowed any `https://*.vercel.app` host, any localhost port, any `guidexpert.co.in` subdomain, and HTTP as well as HTTPS. The two copies could drift.

**Change.** `utils/crmOrigin.js` is the only allow-list. `server.js` calls `crmCorsOrigin`. CRM login, forgot-password, and reset still call `assertAllowedOrigin` from that module.

When `NODE_ENV` is `production`, the allowed origins are:

- `https://www.guidexpert.co.in`
- `https://guidexpert.co.in`
- `https://guide-xpert-frontend.vercel.app`
- extra exact `https` origins from `FRONTEND_URL`, split on commas

Those three hosts were already named in `server.js`. They were not guessed as new domains. HTTP origins, localhost, subdomains, and other `*.vercel.app` hosts are rejected in production. A rejected origin gets no `Access-Control-Allow-Origin` header. A missing `Origin` is allowed: browsers send `Origin` on cross-site requests, and state-changing CRM routes still require the session cookie and CSRF. Development and test also allow `http` or `https` on `localhost` and `127.0.0.1` with any port, plus the exact `FRONTEND_URL` value.

`server.js` sets `trust proxy` to `1` only when `VERCEL` is `1`. Client `X-Forwarded-For` and `Forwarded` headers are not parsed in application code. `vercel.json` and `.env` were not edited.

**Files.** `utils/crmOrigin.js`, `server.js`, `test/crmOrigin.test.js`.

## 4. Cross-consultancy phone response

**Issue.** An update or create that hits a phone owned by another consultancy returns `409 duplicate_student` and no student payload. The payload no longer contains the other consultancy's student. The status still tells the caller that the phone exists somewhere, because the phone index is global.

**Decision.** The status, code, and message were not changed. Success versus failure is already visible while the phone is globally unique. A different error code would be a second signal. A successful response that does not save the student would be a different API contract, and the portal and existing tests depend on `409`. Hiding the signal needs a product decision: per-consultancy phone uniqueness, or an asynchronous accept that does not tell the caller whether the write landed.

In-scope duplicates still return the student the caller is allowed to read. Out-of-scope conflicts, including a soft-deleted student outside the caller's consultancies, stay `409 duplicate_student` with `data: null` and the same message. The duplicate-key path uses that same helper, so a race does not leave a partial student. Concurrent create and create-versus-update tests lock the redaction.

**Files.** Comment in `services/crm/studentService.js`. Tests in `test/crmAssignment.test.js`.

## 5. Shared rate limits

**Issue.** Login and heartbeat counters were process-local `Map`s. Vercel runs more than one isolate, so those counters did not apply across instances. The repositories do not contain Redis or another approved shared cache. MongoDB is already required for CRM transactions.

**Change.** `services/crm/crmRateLimit.js` counts in the `crmRateLimits` collection when `NODE_ENV` is `production`. Development and test keep the memory map. There is no production switch back to memory. A MongoDB error becomes `503 rate_limit_unavailable` and the attempt is denied. Login still checks both the client IP and the account identifier, so one address shared by a proxy is not the only control. Account lockout on `CrmUser.lockedUntil` is unchanged. Heartbeat throttling uses the same store and the existing per-session cap. `assertLoginAllowed` and `consumeHeartbeat` are awaited.

The model declares a unique index on `key`. Remote databases do not build indexes on startup. The production index was not created. Until it exists, two concurrent first inserts for a new key can under-count. The limiter still denies once a stored count is over the cap, and a store error still denies the request. `scripts/syncCrmIndexes.js` now includes the model for local and test index sync. That script still refuses production and non-local URIs. The assignment-index script was not pointed at this collection.

**Files.** `models/CrmRateLimit.js`, `services/crm/crmRateLimit.js`, `services/crm/crmLoginLimiter.js`, `services/crm/crmAuthService.js`, `services/crm/crmPresence.js`, `scripts/syncCrmIndexes.js`, `test/crmRateLimit.test.js`.

## Tests

Commands were run from the repository directories. Exit status 0 unless noted.

Backend, one process, concurrency 1:

`node --test --test-concurrency=1 test/crmPhase1.test.js test/crmUserAuth.test.js test/crmAssignment.test.js test/crmActivity.test.js test/crmPresence.test.js test/crmOperations.test.js test/crmAssignmentIndex.test.js test/crmOrigin.test.js test/crmRateLimit.test.js`

Result: 78 passed, 0 failed, exit 0.

Covered here: duplicate active rows with the index dropped, both rows revoked, other pairs left active, repeat revoke `404`, re-assignment, audit `revokedCount`, audit-failure rollback, concurrent cross-consultancy create and create-versus-update redaction, production and development origins, CORS headers, shared MongoDB keys, store failure `503`, and the memory fallback.

Frontend:

`npx eslint src/utils/crmSessionApi.js src/utils/crmSessionGuard.js src/utils/crmSessionGuard.test.js src/pages/crm-app/CrmSessionContext.jsx src/utils/crmPresenceHeartbeat.js src/utils/crmPresenceHeartbeat.test.js`

`npm test`

`npm run build`

ESLint on those files, 119 frontend tests, and the Vite production build all exited 0. The session-guard tests cover logout, a new session key, a late heartbeat `401`, a current heartbeat `401`, `403`, network failure, and the login path. The existing heartbeat scheduler tests still pass.

No browser login, refresh, back, forward, or logout was run. The local API process was not restarted and was not used as evidence.

## Owner decisions still required

- Confirm the production browser origins. `https://guide-xpert-frontend.vercel.app` is the Vercel host already written in the old allow-list. The frontend `vercel.json` rewrites `/api` to `gxp-new-backend.vercel.app` and does not name the browser origin. Any other production host must be an exact `https` value in `FRONTEND_URL`. Preview hosts are no longer accepted in production.
- Confirm the API is served by Vercel with exactly one proxy hop. `trust proxy` is enabled only when Vercel sets `VERCEL=1`. An extra CDN in front would make `req.ip` the proxy address. The per-account login limit remains in addition to the IP limit.
- Choose whether a phone that exists in another consultancy may keep returning `409 duplicate_student`. This phase kept that contract.
- Create the unique index on `crmRateLimits.key` in the production database before relying on the shared counter for concurrent first requests. This phase did not create it. Example for an operator, not executed here: create a unique index named `key_1` on `{ key: 1 }` in `crmRateLimits`.
- Apply the assignment partial unique index with `docs/CRM_ASSIGNMENT_INDEX_RUNBOOK.md`. This phase did not run it.

## Production checks still required

- The live `crmConsultancyAssignments` index `consultancyId_1_crmUserId_1` is unique and partial on `revokedAt: null`, with no duplicate active pairs.
- The live `crmRateLimits` unique index on `key` exists.
- A production login response sets `Secure` on the session and CSRF cookies, over HTTPS, with `SameSite=Lax` and no broad `Domain`.
- The deployed API accepts the confirmed production origin and rejects a preview origin, an HTTP origin, and an unknown HTTPS origin.
- A real browser can log in, refresh, go back, log out, and log in again without a late heartbeat `401` clearing the new session.

## Files changed in this phase

Backend:

- `services/crm/crmAssignmentService.js`
- `services/crm/studentService.js`
- `services/crm/crmAuthService.js`
- `services/crm/crmLoginLimiter.js`
- `services/crm/crmPresence.js`
- `services/crm/crmRateLimit.js` (new)
- `models/CrmRateLimit.js` (new)
- `utils/crmOrigin.js`
- `server.js`
- `scripts/syncCrmIndexes.js`
- `test/crmAssignment.test.js`
- `test/crmOrigin.test.js` (new)
- `test/crmRateLimit.test.js` (new)
- `docs/CRM_ASSIGNMENT_INDEX_RUNBOOK.md`
- `docs/CRM_PHASE11_REMEDIATION_REPORT.md` (this file)

Frontend:

- `src/utils/crmSessionGuard.js` (new)
- `src/utils/crmSessionGuard.test.js` (new)
- `src/utils/crmSessionApi.js`
- `src/pages/crm-app/CrmSessionContext.jsx`

No other files were edited for this phase. Demo routes, platform Admin authentication, and `/crm/demo` were not changed. Existing security assertions were not relaxed. The previous characterization that one active row survived revoke was replaced with the requirement that none survive.
