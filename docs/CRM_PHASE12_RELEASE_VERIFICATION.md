# CRM Phase 12 — Production index readiness and release verification

- **Date:** 2026-10-25
- **Node:** v24.21.0
- **Verdict:** **NOT SAFE TO RELEASE**

No commit, push, deployment, production environment change, or production database command was run. Neither index migration was executed. `syncIndexes()` was not run against a remote database. No database URI, credential, cookie, reset token, or student record is recorded here.

An in-memory test and a successful frontend build do not make either production index ready.

## 1. Executive verdict

**NOT SAFE TO RELEASE**

The working tree has separate, approval-gated procedures for both required indexes. Those procedures were exercised only on in-memory replica sets. The intended database was not inspected.

Release stays blocked until all of the following are true:

1. `crmConsultancyAssignments` has unique `consultancyId_1_crmUserId_1` with partial filter `{ revokedAt: null }`, confirmed on the intended database.
2. `crmRateLimits` has unique `key_1` on `{ key: 1 }` with no partial filter, confirmed on that same database.
3. Production HTTPS cookies and the deployed CORS allow-list are observed on the host that will serve this code.
4. The browser session checklist below is passed by an authorized tester with test accounts.

The committed `HEAD` of each repository is not this working tree. Deploying the current branch tips would not ship the Phase 11 fixes or these procedures.

## 2. Repository baseline

Parent folder `/Users/venkatesh/Guidexpert` is not a git repository. Both working trees were already dirty. This phase did not reset, clean, stash, or discard anything.

| Repository | Branch | HEAD | Tracking |
|---|---|---|---|
| `GuideXpert-Backend` | `feat/consultancy-crm-phase-1` | `c11c77144365be78b10f39909057739e5e0d491e` | `origin/feat/consultancy-crm-phase-1` (same commit) |
| `GuideXpert-Frontend` | `main` | `c1c30aba0f6ef99aa69b8c9a0b9ed900ed70b22f` | `origin/main` (same commit) |

`package.json` and both lockfiles are unmodified.

### What this phase changed

- `scripts/ensureCrmRateLimitIndex.js` — additive `crmRateLimits` index command. Not executed against `.env` or any remote database.
- `test/crmRateLimitIndex.test.js` — in-memory procedure tests and a model-to-procedure comparison.
- `docs/CRM_RATE_LIMIT_INDEX_RUNBOOK.md` — operator procedure.
- `docs/CRM_ASSIGNMENT_INDEX_RUNBOOK.md` — one sentence pointing operators at the separate rate-limit procedure and away from `scripts/syncCrmIndexes.js`.
- This report.

No Admin page, demo page, route, or authentication behavior was edited.

## 3. Index definitions

Both declarations were read from the models and compared with the procedure constants. The comparison test passed. Nothing below was read from a production server.

### `crmConsultancyAssignments`

| Source | Key | Unique | Partial filter | Name |
|---|---|---|---|---|
| `models/CrmConsultancyAssignment.js` | `{ consultancyId: 1, crmUserId: 1 }` | yes | `{ revokedAt: null }` | Mongoose default `consultancyId_1_crmUserId_1` |
| `scripts/ensureCrmAssignmentIndex.js` | same order | yes | `{ revokedAt: null }` | `consultancyId_1_crmUserId_1` |

The model also declares non-unique `{ crmUserId: 1, revokedAt: 1 }` and `{ consultancyId: 1, revokedAt: 1 }`. Those keys do not collide with the unique index. The assignment procedure does not create them. They are not part of this release migration. Queries remain correct without them; they are not the uniqueness guarantee.

Revoked rows are outside the partial filter, so a revoked pair can be assigned again. Two active rows for the same pair cannot both exist once the index is in place. A duplicate insert inside `commitWithAudit` becomes `409 duplicate_assignment`. Revoke updates every active row for that pair in one transaction. A concurrent insert of a different document can still commit while the index is absent.

The procedure refuses to create the index when more than one active row exists for a pair, and it refuses to alter an existing same-key index that is not unique or does not use that partial filter. It does not call `syncIndexes()` and does not drop indexes.

### `crmRateLimits`

| Source | Key | Unique | Partial filter | Name |
|---|---|---|---|---|
| `models/CrmRateLimit.js` (`key` is `unique: true`) | `{ key: 1 }` | yes | none | Mongoose default `key_1` |
| `scripts/ensureCrmRateLimitIndex.js` | `{ key: 1 }` | yes | none | `key_1` |

There is no second index on this collection in the model. The procedure does not delete or rewrite documents. Duplicate `key` values, including several documents with no `key`, stop the command before `createIndex`. The failure text lists document ids and the group count. It does not list key strings. A same-key index that is not unique, or that has a partial filter, is left in place. An already-correct `{ key: 1 }` unique index is left in place, including when its name is not `key_1`.

Production login and heartbeat counters use this collection when `NODE_ENV` is `production`. A duplicate-key error on a concurrent first insert becomes `503 rate_limit_unavailable`. Those writes are single-document updates. They are not CRM multi-document transactions. Until the unique index exists, two first inserts of a new key can both succeed and the counter can stay under the cap.

### Startup and other index paths

- `server.js` connects through `config/db.js`, which loads `config/mongooseSafety.js`. For a remote URI, `autoIndex` is forced off unless `ALLOW_REMOTE_AUTO_INDEX=1`. The API process does not call `syncIndexes()` or `createIndexes()`.
- `scripts/syncCrmIndexes.js` refuses `NODE_ENV=production` and every non-local URI. Its command line calls `createIndexes()` on every CRM model, including both collections above. `syncCrmIndexes()` itself calls `Model.syncIndexes()`, which drops indexes that are not on the schema. That function is for the in-memory test. It is not an approved production migration.
- Both ensure scripts connect only from their command-line entry point. Importing them does not load `.env`. They do not load Mongoose models, so the connection does not build other declared indexes. They still must not be pointed at production without the approval and backup steps in their runbooks.

## 4. Migration readiness

Both procedures are ready to hand to an operator. Neither has been run. The target database is not known to have either index, and duplicate documents were not counted there.

### Assignment index

Follow `docs/CRM_ASSIGNMENT_INDEX_RUNBOOK.md` only.

1. Back up the target database and confirm the backup restores.
2. Get approval for this one index.
3. Resolve duplicate active pairs by hand. Revoking an extra active row is the usual repair. Do not delete a row unless that repair is approved.
4. Run `CRM_ASSIGNMENT_INDEX_APPLY=1 node scripts/ensureCrmAssignmentIndex.js --database <database-name>` with `MONGODB_URI` aimed at that database. `--database` must equal the database name in the URI.
5. Read back `consultancyId_1_crmUserId_1`: key `{ consultancyId: 1, crmUserId: 1 }`, `unique: true`, `partialFilterExpression: { revokedAt: null }`.
6. With test accounts, confirm a second active assignment returns `409 duplicate_assignment`, revoke then returns `404`, re-assignment is allowed, and a user assigned only to consultancy A receives `404` for consultancy B.

Rollback, separately approved, drops only `consultancyId_1_crmUserId_1`. It does not drop the collection.

### Rate-limit index

Follow `docs/CRM_RATE_LIMIT_INDEX_RUNBOOK.md` only. Do not combine it with the assignment command or with `syncCrmIndexes.js`.

1. Back up the target database and confirm the backup restores.
2. Get approval for this one index. Assignment-index approval is not this approval.
3. Let the script inspect indexes and duplicate keys. If it reports duplicate groups, stop. Do not delete or rewrite rate-limit documents to force the build. Repair those documents under a separate approval.
4. Run `CRM_RATE_LIMIT_INDEX_APPLY=1 node scripts/ensureCrmRateLimitIndex.js --database <database-name>`.
5. Read back `key_1`: key `{ key: 1 }`, `unique: true`, no partial filter. Confirm the document count is unchanged.
6. A store error, including a duplicate-key race, must deny the login or heartbeat with `503 rate_limit_unavailable`.

If the collection is missing, the command creates the empty collection and the index. It does not insert a counter.

Rollback, separately approved, drops only `key_1`. It does not drop `crmRateLimits` and it does not drop any other index. After that drop, concurrent first inserts can under-count again.

Failure before creation leaves the collection unchanged. The command prints a fixed failure line and an error code. It does not print driver error text.

## 5. Deployment assumptions

### Confirmed from repository files

These are source and config facts. They are not a reading of the live Vercel project or the live database.

- Production browser origins hardcoded in `utils/crmOrigin.js` are `https://www.guidexpert.co.in`, `https://guidexpert.co.in`, and `https://guide-xpert-frontend.vercel.app`.
- `FRONTEND_URL` is split on commas and trimmed. In production, only values whose parsed `origin` is exactly that string, using `https`, and with no username or password, are added. Wildcards are not accepted. HTTP values in `FRONTEND_URL` are ignored in production.
- Unknown HTTPS origins, `https://*.vercel.app` preview hosts, HTTP origins, localhost, and `guidexpert.co.in` subdomains are rejected when `NODE_ENV` is `production`. A rejected browser origin gets no `Access-Control-Allow-Origin` header. A missing `Origin` is allowed. State-changing CRM routes still require the session cookie and `x-crm-csrf`.
- Backend `vercel.json` sets `NODE_ENV` to `production` in the committed env block. `FRONTEND_URL` is not in that file. `.env.example` shows `FRONTEND_URL=https://www.guidexpert.co.in`, which is already one of the three hardcoded origins. The live dashboard value was not read.
- Frontend `vercel.json` rewrites `/api/:path*` to `https://gxp-new-backend.vercel.app/api/:path*`.
- `src/utils/apiBaseUrl.js` uses same-origin `/api` for `localhost`, `127.0.0.1`, any `*.vercel.app` host, `guidexpert.co.in`, `www.guidexpert.co.in`, and any `*.guidexpert.co.in` host. The absolute fallback is `https://gxp-new-backend.vercel.app/api`. The file also recognizes the string `guide-xpert-backend.vercel.app` when deciding whether a dev `VITE_API_URL` should use the proxy. That host is not a CRM browser origin.
- `cookieSecure()` is true only when `NODE_ENV === 'production'`. The session cookie is `HttpOnly`. The CSRF cookie is not. Both use `SameSite=Lax`, `Path=/`, and no `Domain`, so they are host-only when the browser stores them.
- The working-tree `server.js` sets `trust proxy` to `1` only when `VERCEL === '1'`. Application code does not read `X-Forwarded-For` or `Forwarded`. Login limits the account identifier as well as `req.ip`.
- Another proxy in front of Vercel, with `trust proxy` still at `1`, makes `req.ip` the nearest proxy address rather than the browser. One shared address can then exhaust the IP bucket. The per-account bucket still applies. If `VERCEL` is unset, Express does not trust forwarded headers and `req.ip` is the immediate peer.
- `commitWithAudit` starts a MongoDB transaction. Callers that pass `requireTransaction: true` return `503 transaction_required` when the server reports that transactions need a replica set or mongos. Assignment, student, referral, session, and password writes use that path. `config/db.js` comments mention an Atlas M10 pool and a monitor connection per replica member. That comment is not a live topology check.

### Not verified, and required from the deployment owner

- The Vercel project that serves `gxp-new-backend.vercel.app` is the process that will run this working tree.
- The live `NODE_ENV` is `production`, so `Secure` is set on the cookies.
- Vercel sets `VERCEL=1` on that project and there is exactly one trusted proxy hop.
- The live `FRONTEND_URL`, if set, is a list of exact `https` origins the owner intends to allow.
- `https://guide-xpert-frontend.vercel.app` is still a production browser origin. Preview frontend hosts will send their own `Origin` and the production API will reject them.
- The connected MongoDB deployment is a replica set or mongos. A standalone server will refuse CRM transactions.
- Neither index exists, or does exist, on that database. This phase did not look.

## 6. Browser checklist

Use test CRM accounts and consultancy records created for the check. Do not use a real student's record. Record cookie flags only. Do not record cookie values, CSRF tokens, or response bodies that contain personal data.

This phase did not open a browser, did not log in, and did not call the production API. Every row is **Not tested**.

| # | Check | Evidence |
|---|---|---|
| 1 | Log in on the confirmed production HTTPS origin. | Not tested |
| 2 | Session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, and host-only. Do not record the value. | Not tested |
| 3 | A state-changing portal request without `x-crm-csrf` fails, and the same request with the CSRF cookie value succeeds. | Not tested |
| 4 | Refresh `/crm/app`. The session is restored. | Not tested |
| 5 | Back and forward across login, `/crm/app`, and logout stay on the session that matches the screen. | Not tested |
| 6 | Log out while a heartbeat request is in flight. | Not tested |
| 7 | Log in again. The previous heartbeat's `401` does not clear the new session. | Not tested |
| 8 | A `401` for the current session still returns the browser to login. | Not tested |
| 9 | From production, an unknown HTTPS origin, a Vercel preview origin, and an HTTP origin are rejected and receive no `Access-Control-Allow-Origin`. | Not tested |
| 10 | `/crm/demo` does not call authenticated CRM APIs. | Not tested |
| 11 | Revoking the test user's assignment makes the next read of that consultancy `404`. | Not tested |
| 12 | A user assigned only to consultancy A receives `404` for consultancy B's consultancy, student, and referral routes. | Not tested |

Code review, not a browser pass: pages under `src/pages/crm-demo/` do not import `crmSessionApi` and do not call `fetch`. `crmDemoStore.js` persists under `guidexpert_crm_demo_v1` and states that it does not read or write auth tokens. The frontend test "demo operations do not call fetch or write unrelated storage keys" passed. That does not complete checklist item 10.

## 7. Automated tests

Commands ran from each repository. Exit status is 0.

Backend, concurrency 1:

`node --test --test-concurrency=1 test/crmPhase1.test.js test/crmUserAuth.test.js test/crmAssignment.test.js test/crmActivity.test.js test/crmPresence.test.js test/crmOperations.test.js test/crmAssignmentIndex.test.js test/crmOrigin.test.js test/crmRateLimit.test.js test/crmRateLimitIndex.test.js`

Result: **83 passed, 0 failed**, exit 0. The five new rate-limit index tests are included. They used `MongoMemoryReplSet` only.

Frontend:

`npx eslint src/utils/crmSessionApi.js src/utils/crmSessionGuard.js src/utils/crmSessionGuard.test.js src/pages/crm-app/CrmSessionContext.jsx src/utils/crmPresenceHeartbeat.js src/utils/crmPresenceHeartbeat.test.js src/utils/crmDemoStore.js src/pages/crm-demo/useCrmDemo.js`

`npm test`

`npm run build`

ESLint on those files, **119** frontend tests, and the Vite production build all exited 0.

The final diff for this phase is the files in section 2. Lockfiles are clean. The new script contains no remote connection, no `syncIndexes()` call, and no document delete or update. The in-memory tests print generated document ids when they refuse a duplicate key. Those ids belong to the memory server.

## 8. Remaining blockers

| Blocker | Owner | Action |
|---|---|---|
| Assignment unique partial index not confirmed on the intended database | Database operator | Backup, approval, then `docs/CRM_ASSIGNMENT_INDEX_RUNBOOK.md`. Do not run it until that approval exists. |
| Rate-limit unique index not confirmed on the intended database | Database operator | Separate backup confirmation and approval, then `docs/CRM_RATE_LIMIT_INDEX_RUNBOOK.md`. Do not rewrite counters to force the build. |
| Replica set or mongos not confirmed | Database operator | Confirm the connected topology before CRM writes. A standalone server returns `503 transaction_required`. |
| Working tree is not `HEAD` | Release owner | Ship the uncommitted CRM tree only through the normal review path. The current branch tips do not contain it. |
| Production origin list and `FRONTEND_URL` | Deploy owner | Confirm the three hardcoded HTTPS origins and any live `FRONTEND_URL` values. Preview hosts are rejected. |
| `NODE_ENV=production` and one Vercel proxy hop | Deploy owner | Confirm the live env matches `vercel.json` and that no extra CDN sits in front of `trust proxy` `1`. |
| HTTPS cookie flags and deployed CORS | Authorized tester | Complete checklist items 2 and 9 on the production origin. |
| Browser session lifecycle | Authorized tester | Complete checklist items 1 and 3–8 and 11–12 with test accounts. |
| `/crm/demo` network behavior | Authorized tester | Complete checklist item 10 in the browser. |
| Cross-consultancy phone `409` | Product owner | Still the Phase 11 contract. This phase did not change it. |

## 9. Production changes

None. This phase did not commit, push, deploy, edit production environment variables, connect to the production database, run either ensure script against a real URI, or run `syncIndexes()` against a remote database.
