# CRM Phase 13 — Release execution and production verification

- **Date:** 2026-10-25
- **Node:** v24.21.0
- **Overall verdict:** **NOT SAFE TO RELEASE**

This phase did not commit, push, deploy, change a production environment variable, connect to a production database, or run either index command. `syncIndexes()` was not run against a remote database. No URI, credential, cookie, CSRF token, reset token, or student record is recorded here.

This prompt was not treated as approval to mutate production. Backup confirmation, a named target database, a deployment-owner statement, and an authorized tester were not available. Those operations were stopped and are recorded as blocked.

Passing tests in this document are working-tree results. They are not proof of the production database or of deployed behavior.

## Verdicts

| Gate | Verdict | Why |
|---|---|---|
| Code and automated tests | **READY FOR APPROVAL** | The Phase 11 and Phase 12 behavior is in the working tree and the suites below passed. The changes are not on `HEAD` and have not entered the normal review and release process. |
| Assignment index | **BLOCKED** | No backup confirmation, no approval for a named database, and no read-back from that database. |
| Rate-limit index | **BLOCKED** | Separate approval and backup confirmation are absent. The assignment gate does not cover this index. |
| Production configuration | **BLOCKED** | No deployment owner supplied live evidence. Repository files were not changed. |
| Browser and session verification | **BLOCKED** | No authorized tester performed the checklist. |
| Product phone contract | **BLOCKED** | The current `409 duplicate_student` response was left in place. A product owner has not accepted or replaced it. |
| Overall release | **NOT SAFE TO RELEASE** | Indexes, live configuration, browser checks, and the review path are still open. |

## 1. Repository state

The parent folder `/Users/venkatesh/Guidexpert` is not a git repository. The two apps were inspected separately. Nothing was staged. Nothing was reset, cleaned, stashed, discarded, or rebased.

| Repository | Branch | HEAD | Tracking | Ahead/behind |
|---|---|---|---|---|
| `GuideXpert-Backend` | `feat/consultancy-crm-phase-1` | `c11c77144365be78b10f39909057739e5e0d491e` | `origin/feat/consultancy-crm-phase-1` at the same commit | Tracking tip matches HEAD |
| `GuideXpert-Frontend` | `main` | `c1c30aba0f6ef99aa69b8c9a0b9ed900ed70b22f` | `origin/main` at the same commit | Tracking tip matches HEAD |

Staged diff in both repositories: empty.

Unstaged backend diff: 27 tracked files, 1458 insertions, 361 deletions. Unstaged frontend diff: 42 tracked files, 1125 insertions, 785 deletions. `package.json` and both lockfiles are outside those diffs.

Untracked backend files include the CRM models, services, tests, both ensure scripts, both index runbooks, and the Phase 8, 10, 11, and 12 reports. Untracked frontend files include `src/utils/crmSessionGuard.js`, `src/utils/crmPresenceHeartbeat.js`, their tests, and the CRM workspace and legacy-redirect files. Demo and admin paths that were already dirty were not edited in this phase.

`HEAD` does not contain the Phase 11 fixes or the Phase 12 index procedures. Deploying either branch tip would ship the last commit, not this working tree.

### Working-tree confirmation

These behaviors were read from the current files. They match the Phase 11 and Phase 12 reports. No missing or conflicting implementation was found in this pass.

| Behavior | Where it is |
|---|---|
| Revoke updates every active row for the pair and audits `revokedCount` | `services/crm/crmAssignmentService.js` |
| Session epoch captured before `fetch`; logout calls `retireCrmSession()` first | `src/utils/crmSessionGuard.js`, `src/utils/crmSessionApi.js`, `src/pages/crm-app/CrmSessionContext.jsx` |
| One production HTTPS origin list used by CORS and CRM login | `utils/crmOrigin.js`, `server.js` |
| `trust proxy` is 1 only when `VERCEL` is `1` | `server.js` |
| Production rate limits use MongoDB; a store error denies the attempt | `services/crm/crmRateLimit.js`; login and heartbeat `await` the limiter |
| Out-of-scope phone conflict stays `409 duplicate_student` with no student payload | `services/crm/studentService.js` |
| Assignment index command refuses to run without `CRM_ASSIGNMENT_INDEX_APPLY=1` and a matching database name | `scripts/ensureCrmAssignmentIndex.js` |
| Rate-limit index command refuses to run without its own flag and database name, and does not print key values | `scripts/ensureCrmRateLimitIndex.js` |

The assignment runbook requires a restorable backup, approval for this index, duplicate active-pair repair by hand, database-name confirmation, read-back of `consultancyId_1_crmUserId_1`, and post-checks with test accounts. The rate-limit runbook requires a separate backup and approval, stops on duplicate keys without rewriting documents, reads the index back, and forbids `scripts/syncCrmIndexes.js`.

No new regression test was added. The existing suites already cover revoke-all, the session epoch, origins, both index procedures, and the redacted phone conflict. This run did not find a failing assertion.

## 2. Release gates

| Blocker | Requirement | Owner | Evidence required | Approval required | Status | Safe next action |
|---|---|---|---|---|---|---|
| Working tree is not a reviewed commit | Ship only through the normal review path | Release owner | Reviewed diff of this tree, without secrets | Approval to commit and open the release review | **BLOCKED** | Do not deploy `HEAD`. Schedule a review of the uncommitted CRM tree. |
| Assignment index | Unique partial index `consultancyId_1_crmUserId_1` on the intended database | Database operator | Backup restore proof, command output, read-back, test-account checks | Approval for this index and that database name | **BLOCKED** | Complete the operator checklist in section 3. Do not run the command yet. |
| Rate-limit index | Unique `key_1` on `crmRateLimits`, no partial filter | Database operator | Separate backup restore proof, command output, read-back, unchanged document count | A second approval that names this index and the same database | **BLOCKED** | Complete section 4 only after its own approval. |
| MongoDB transactions | The connected deployment is a replica set or mongos | Database operator | Topology statement that does not include the URI | Confirmation of the cluster type | **BLOCKED** | Confirm topology before CRM writes. Do not connect from this phase. |
| Deployed code identity | The live API is this reviewed tree | Deployment owner | Deployment id and commit or artifact id | Confirmation that the deployment is the reviewed tree | **BLOCKED** | Fill section 5. Change nothing in the dashboard. |
| `NODE_ENV` | Production value is `production` | Deployment owner | Name of the variable and the value `production` only | Confirmation | **BLOCKED** | Read the live env. Do not paste other variables. |
| Proxy trust | `VERCEL=1` and exactly one trusted hop | Deployment owner | Whether an extra CDN sits in front of Vercel | Confirmation of the hop count | **BLOCKED** | Record the path from browser to API. |
| `FRONTEND_URL` and hardcoded origins | Only intended exact HTTPS origins | Deployment owner | Origin list, not secrets | Written acceptance of each origin | **BLOCKED** | Compare the live list with section 5. |
| Frontend rewrite | `/api` reaches the intended backend | Deployment owner | Rewrite destination host | Confirmation | **BLOCKED** | Compare with `GuideXpert-Frontend/vercel.json`. |
| Cookies and CSRF | `Secure`, `HttpOnly`, `SameSite=Lax`, host-only; CSRF required | Authorized tester | Flag checklist, no cookie value | Tester assigned | **BLOCKED** | Section 6, items 2 and 3. |
| Browser session lifecycle | Login, refresh, history, logout, stale and current `401` | Authorized tester | Filled rows in section 6 | Tester assigned | **BLOCKED** | Do not mark a row passed in advance. |
| Demo isolation | `/crm/demo` does not call CRM APIs or auth storage | Authorized tester | Network log summary with no tokens | Tester assigned | **BLOCKED** | Section 6, item 10. |
| Phone conflict contract | Keep or replace `409 duplicate_student` with `data: null` | Product owner | Written decision and, if it changes, a compatibility plan | Explicit approval before any code change | **BLOCKED** | Leave the response unchanged. |

## 3. Assignment index — operator checklist

Change record: assignment index only. Status: **BLOCKED**. This phase did not run it.

Required result:

- Collection `crmConsultancyAssignments`
- Key `{ consultancyId: 1, crmUserId: 1 }`
- `unique: true`
- `partialFilterExpression: { revokedAt: null }`
- Name `consultancyId_1_crmUserId_1`

The script does not delete or revoke rows. If the preflight finds duplicate active pairs, it prints the pair count and assignment ids, exits non-zero, and leaves every index as it was. Repair those rows by hand under a separate approval. Revoking an extra active row is the usual repair. Do not delete a row unless that repair is approved.

| Step | Required evidence | Result |
|---|---|---|
| Backup taken and a restore was confirmed | Backup id and restore check. No URI. | Not supplied |
| Approval names this index and the database name | Approver, date, database name | Not supplied |
| `MONGODB_URI` database name equals `--database` | The database name only | Not supplied |
| Duplicate active pairs resolved, or preflight reports zero | Pair count. Ids only if a repair is required | Not run |
| Command run with `CRM_ASSIGNMENT_INDEX_APPLY=1` | `Created crmConsultancyAssignments.consultancyId_1_crmUserId_1.` or the already-matches line | Not run |
| Read-back matches the key, unique flag, and partial filter | Index description with no documents | Not run |
| Second active assignment returns `409 duplicate_assignment` | Status and code, test account | Not run |
| Revoke, then the user receives `404` for that consultancy | Status codes, test account | Not run |
| The same pair can be assigned again | `201`, then a successful read | Not run |
| User of consultancy A receives `404` for B's consultancy, student, and referral | Three status codes | Not run |

Command, only after the first three rows are filled:

```bash
CRM_ASSIGNMENT_INDEX_APPLY=1 node scripts/ensureCrmAssignmentIndex.js --database <database-name>
```

Do not use `scripts/syncCrmIndexes.js`. Rollback, if later approved on its own, drops only `consultancyId_1_crmUserId_1`.

## 4. Rate-limit index — operator checklist

Change record: rate-limit index only. Status: **BLOCKED**. Approval for the assignment index is not approval for this one. This phase did not run it.

Required result:

- Collection `crmRateLimits`
- Key `{ key: 1 }`
- `unique: true`
- No partial filter
- Name `key_1`

The script does not update or delete documents. Duplicate keys stop the build. The message contains the group count and document ids. It does not contain key strings. Do not delete or rewrite counters to force the build. The command does not print a document count; record the count with a count-only query before and after.

| Step | Required evidence | Result |
|---|---|---|
| Separate backup and restore confirmation | Backup id. No URI. | Not supplied |
| Approval names `crmRateLimits.key_1` and the database name | Approver, date, database name | Not supplied |
| Document count recorded before the command | A number only | Not supplied |
| Duplicate-key preflight is zero, or the command stops | Group count. Ids only if it stops. No key text | Not run |
| Command run with `CRM_RATE_LIMIT_INDEX_APPLY=1` | `Created crmRateLimits.key_1.` or the already-matches line | Not run |
| Read-back: `{ key: 1 }`, unique, no partial filter, name `key_1` | Index description | Not run |
| Document count after the command equals the count before | Two numbers | Not supplied |

Command, only after the first two rows are filled:

```bash
CRM_RATE_LIMIT_INDEX_APPLY=1 node scripts/ensureCrmRateLimitIndex.js --database <database-name>
```

Do not use `scripts/syncCrmIndexes.js`. Rollback, if later approved on its own, drops only `key_1`.

## 5. Deployment checklist

Fill this from the deployment dashboard and the production host. Do not paste secrets. This phase changed no live setting. Every evidence cell is empty because no owner supplied it.

Repository facts the owner should compare, not live proof:

- Backend `vercel.json` sets `NODE_ENV` to `production`. `FRONTEND_URL` is not in that file.
- Hardcoded production origins are `https://www.guidexpert.co.in`, `https://guidexpert.co.in`, and `https://guide-xpert-frontend.vercel.app`.
- Production also accepts exact `https` origins from `FRONTEND_URL`. HTTP values, wildcards, localhost, subdomains, and other `*.vercel.app` hosts are rejected.
- Frontend `vercel.json` rewrites `/api/:path*` to `https://gxp-new-backend.vercel.app/api/:path*`.
- Session cookies are `Secure` only when `NODE_ENV` is `production`. The session cookie is `HttpOnly`. The CSRF cookie is not. Both are `SameSite=Lax`, `Path=/`, and have no `Domain`.
- `trust proxy` is 1 only when `VERCEL` is `1`. An extra CDN in front of that single hop makes `req.ip` the proxy address. The login identifier limit still applies.
- CRM multi-document writes use `commitWithAudit` and require a replica set or mongos. A standalone server returns `503 transaction_required`.

| Check | Evidence to record | Evidence supplied |
|---|---|---|
| Vercel backend project and deployment match the reviewed working tree | Project name, deployment id, commit or artifact id | None |
| `NODE_ENV` is `production` | The value `production` | None |
| `VERCEL` is `1` | Present or absent | None |
| Proxy path has exactly one trusted hop | Browser, CDN if any, Vercel, API | None |
| `FRONTEND_URL` values are exact intended HTTPS origins | Origin strings only | None |
| The three hardcoded origins are still authorized | Yes or no for each origin | None |
| Frontend `/api` rewrite host is the intended API | Host name | None |
| MongoDB topology is a replica set or mongos | Cluster type, not the URI | None |
| No preview or unknown origin is on the live allow-list | Allow-list comparison | None |

## 6. Browser checklist

Use CRM accounts and consultancy or student records created for this test. Do not use a real student's record. Record flags and status codes. Do not record cookie values, CSRF tokens, or personal fields.

No authorized tester was available. Observed result, tester, timestamp, and evidence location are blank for every row. A blank row is not a pass.

| # | Setup | Action | Expected result | Observed | Tester | Timestamp | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | Test account on the confirmed production HTTPS origin | Log in | Portal loads and a CRM session is established | | | | |
| 2 | Same session | Read `Set-Cookie` flags for `gx_crm_session` and `gx_crm_csrf` | Session: `Secure`, `HttpOnly`, `SameSite=Lax`, no `Domain`. CSRF: `Secure`, not `HttpOnly`, `SameSite=Lax`, no `Domain` | | | | |
| 3 | Same session | State-changing request without `x-crm-csrf`, then with it | First request fails the CSRF check. Second request succeeds | | | | |
| 4 | Signed in on `/crm/app` | Refresh | The session is restored | | | | |
| 5 | Login, portal, logout | Back and forward | Each screen matches the session that belongs to it | | | | |
| 6 | Portal with a heartbeat in flight | Log out | Logout completes. The in-flight heartbeat is not treated as the new session | | | | |
| 7 | Immediately log in again | Let the previous heartbeat return `401` | The new session stays in place | | | | |
| 8 | Current session | Cause a current-session `401` | The browser returns to login | | | | |
| 9 | Production API | Requests from an unknown HTTPS origin, a Vercel preview origin, and an HTTP origin | No `Access-Control-Allow-Origin` for those origins | | | | |
| 10 | `/crm/demo` | Use the demo and watch network calls and storage | No authenticated CRM API call and no CRM session or CSRF write | | | | |
| 11 | Test user assigned to one consultancy | Revoke that assignment and read the consultancy | `404` | | | | |
| 12 | User assigned only to consultancy A | Read consultancy B, one of B's students, and one of B's referrals | `404` on all three | | | | |

Code review, not a browser result: `src/pages/crm-demo/` does not import `crmSessionApi` and does not call `fetch`. The demo store uses `guidexpert_crm_demo_v1` and does not describe itself as auth storage. The frontend test "demo operations do not call fetch or write unrelated storage keys" passed. Item 10 is still not tested in a browser.

## 7. Automated verification

No assertion was weakened. No application file was edited after the run. The in-memory index tests print generated ids when they refuse a duplicate. Those ids belong to the memory server and are not copied here.

Backend, from `GuideXpert-Backend`, exit 0:

`node --test --test-concurrency=1 test/crmPhase1.test.js test/crmUserAuth.test.js test/crmAssignment.test.js test/crmActivity.test.js test/crmPresence.test.js test/crmOperations.test.js test/crmAssignmentIndex.test.js test/crmOrigin.test.js test/crmRateLimit.test.js test/crmRateLimitIndex.test.js`

**83 passed, 0 failed.**

Frontend, from `GuideXpert-Frontend`, exit 0:

`npx eslint src/utils/crmSessionApi.js src/utils/crmSessionGuard.js src/utils/crmSessionGuard.test.js src/pages/crm-app/CrmSessionContext.jsx src/utils/crmPresenceHeartbeat.js src/utils/crmPresenceHeartbeat.test.js src/utils/crmDemoStore.js src/pages/crm-demo/useCrmDemo.js`

`npm test` — **119 passed, 0 failed.**

`npm run build` — Vite production build completed.

Defects found in this run: none.

## 8. Product contract

The cross-consultancy phone response remains `409 duplicate_student` with `data: null` and the same message used for an in-scope conflict. In-scope conflicts still return the student the caller can read. This phase did not change that contract. Replacing it needs an explicit product decision and a compatibility plan. That decision was not supplied.

## 9. Who does the remaining work

| Role | Tasks |
|---|---|
| Release owner | Review the uncommitted backend and frontend trees and put them through the normal release path. Do not deploy the current `HEAD` as if it contained this CRM. |
| Database operator | Confirm replica-set or mongos topology. After a restorable backup and approval, run section 3. After a separate backup confirmation and approval, run section 4. Do not combine the commands and do not run `syncCrmIndexes.js`. |
| Deployment owner | Fill section 5 from the live project. Change no setting while collecting evidence. |
| Authorized tester | Perform section 6 with test accounts and synthetic records. Leave a row blank until it is done. |
| Product owner | Accept the current phone `409`, or approve a different contract with a compatibility plan. |

## 10. What this phase did not do

No commit, push, deployment, production environment edit, production database connection, index migration, or remote `syncIndexes()` occurred. No production database was marked ready.
