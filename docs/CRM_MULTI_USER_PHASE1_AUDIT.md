# CRM multi-user Phase 1 audit

Read-only audit and architecture baseline for the Consultancy CRM and its separate CRM-user accounts. No application code, schema, index, or data change was made. Uncommitted work was left in place.

- **Date:** 2026-10-24
- **Node:** v24.21.0
- **Backend:** `/Users/venkatesh/Guidexpert/GuideXpert-Backend`
- **Backend branch / HEAD:** `feat/consultancy-crm-phase-1` @ `c11c771` (`c11c77144365be78b10f39909057739e5e0d491e`), tracking `origin/feat/consultancy-crm-phase-1`
- **Frontend:** `/Users/venkatesh/Guidexpert/GuideXpert-Frontend`
- **Frontend branch / HEAD:** `main` @ `c1c30ab`, tracking `origin/main`
- **Architecture source:** Consultancy CRM production architecture canvas, repository inspection dated 18 Oct 2026. It is a planning record. It is not a schema change.
- **Method:** working-tree read of models, services, routes, middleware, and tests, plus the checks in section B. `npm test` on the backend was not run. That script is the WhatsApp suite.

> **Headline.** CRM users, cookie sessions, permission checks, the five business collections, and both audit logs already exist and should be reused. Production still has no consultancy assignee, no presence heartbeat, and no per-user business analytics. Those are not specified by the architecture record, so this phase does not propose collections or routes for them. The frontend is on `main`, not `feat/consultancy-crm-phase-1`. `feat/consultancy-crm-phase-1` (`829f17d`) is an ancestor of frontend `main`. Frontend `main` is one commit ahead (`c1c30ab`, demo top bar only).

---

## A. Repository structure that was verified

Parent folder `/Users/venkatesh/Guidexpert` is not a git repository. The two apps are separate clones.

### Working trees (preserved, not committed)

Backend, 3 modified files, no untracked files:

| File | Working-tree effect |
|---|---|
| `services/crm/consultancyService.js` | Stops reading and writing `pipelineStage`. Create, update, and list no longer return it or `pipeline` counts. The schema default `fresh` still applies on insert. |
| `server.js` | Removes `ensureLocalCrmTestUser()` from startup. Replaces the shared DB-connect helper with a local retry. The error handler always returns 500. Unmounts `/api/jee-main-mock-test`. Listen is no longer bound to `127.0.0.1`. CRM mounts are unchanged. |
| `controllers/jeeMainMockTestController.js` | Drops the `utm_medium === 'influencer'` name fallback. Not on the CRM route table. |

Frontend, 18 modified files, no untracked files:

| File | Working-tree effect |
|---|---|
| `src/App.jsx` | Removes `/crm/login` and `/crm/reset`. Login and reset are served at `/crm-app/login` and `/crm-app/reset`. |
| `src/pages/crm-app/CrmAppLayout.jsx`, `RequireCrmSession.jsx` | Session gate and logout go to `/crm-app/login`. |
| `src/pages/crm-app/CrmAuthFrame.jsx`, `CrmLoginPage.jsx`, `CrmResetPage.jsx`, `crmLogin.css` | Simpler sign-in and reset screens. |
| `src/pages/crm-app/CrmPortalConsultanciesPage.jsx` | Drops the pipeline-stage filter and the stage on create. |
| `src/pages/crm-demo/ConsultanciesPage.jsx`, `CrmDemoLayout.jsx`, `crmShell.css` | Demo directory becomes stage cards. Layout stops providing `demoRole`. |
| `src/utils/consultancyPipeline.js`, `consultancyPipeline.test.js` | Board stages can come from follow-up status when `pipelineStage` is absent. |
| `src/utils/crmLoginFlow.js`, `crmLoginFlow.test.js` | Shorter login-failure helper. `safeCrmNext` no longer treats `/crm/login` as internal. |
| `index.html`, `src/components/Admin/AdminLayout.jsx`, `src/pages/admin/JeeMainMockTestLeads.jsx` | Title, admin header, and mock-test influencer cell. Not CRM authorization. |

Committed HEAD on both frontend commits still mounts login at `/crm/login` and redirects `/crm-app/login` there. The working tree reverses that.

### Surfaces

| Surface | Auth | Data |
|---|---|---|
| Public `/crm` | None. `CrmDemoLayout` forces the demo client. | `localStorage` key `guidexpert_crm_demo_v1` via `src/utils/crmDemoStore.js`. No `fetch`. |
| Admin `/admin/crm` and `/admin/crm-access` | `ProtectedAdmin`, then `Authorization: Bearer` admin JWT. | `src/utils/crmApi.js` → `/api/admin/crm`. `src/utils/crmUserAdminApi.js` → `/api/admin/crm-users`. |
| Portal `/crm-app` | HttpOnly cookie `gx_crm_session` plus `x-crm-csrf`. | `src/utils/crmSessionApi.js` → `/api/crm-auth` and `/api/crm`. |

`src/utils/crmDataSource.js` selects the API client only when `VITE_CRM_DATA_MODE=api`. `/crm` never passes that client.

### Five business collections (keep)

| Model | Collection | Unique indexes |
|---|---|---|
| `models/CrmStudent.js` | `crmStudents` | `{ phone: 1 }` unique, including soft-deleted rows |
| `models/CrmConsultancy.js` | `crmConsultancies` | `{ normalizedName: 1 }` unique only while `deletedAt` is null and `status` is `active` |
| `models/CrmConsultancyContact.js` | `crmConsultancyContacts` | `{ consultancyId, phone }` unique for active contacts with a string phone |
| `models/CrmReferral.js` | `crmReferrals` | `{ crmStudentId: 1 }` unique. One referral row per student. |
| `models/CrmAuditLog.js` | `crmAuditLogs` | None. Indexes are `{ entityType, entityId, createdAt }`, `{ actorCrmUserId, createdAt }`, `{ actorAdminId, createdAt }`. |

Student fields in use: `fullName`, `phone` (10 digits), `email`, `city`, `notes`, `admissionStatus` (string, max 40, no enum), `createdBy` and `updatedBy` (`ref: 'Admin'`), `deletedAt`. No service sets `deletedAt`. `getStudent` returns a soft-deleted row. `listStudents` hides it.

Consultancy fields in use: `name`, `normalizedName`, `status` (`active` \| `inactive`), `pipelineStage` (`fresh` \| `contacted` \| `meeting_done` \| `onboarded`, default `fresh`), `notes`, `createdBy`, `updatedBy`, `deletedAt`. `DELETE /consultancies/:id` returns 405. The working-tree service ignores `pipelineStage`.

Referral fields in use: current `consultancyId` plus snapshots, `originalConsultancyId` set once, `referredAt`, `sourceCorrectedAt`, `sourceCorrectedBy`, `sourceCorrectionReason` (latest correction only). Each correction also appends `referral.source_corrected`.

Admission statuses, from `constants/crm.js`: Not started, Contacted, Counselling, Applied, Admitted, Enrolled, Not proceeding. Omitted create values become `Not started`. Unknown stored values display as `Not started` and are not rewritten. `ADMISSION_DUPLICATE_POLICY.implemented` is `false`. There is no admission-case collection and no status-history collection. Analytics `basisLabel` in `services/crm/analyticsService.js` says earlier statuses are not stored.

### Identity collections already separate from Admin

`constants/crmUsers.js` states that CRM-user authorization is separate from `Admin.sectionAccess`. Tests assert the credentials are not interchangeable.

| Model | Collection | Identity rule |
|---|---|---|
| `models/CrmUser.js` | `crmUsers` | `email` and `username` unique with no partial filter. `role` is `crm_administrator` (rank 3), `crm_manager` (rank 2), or `crm_viewer` (rank 1). `permissions` is an array of the 18 `crm.*` keys. `sessionVersion` starts at 1. `deletedAt` is unused by the API. |
| `models/CrmSession.js` | `crmSessions` | SHA-256 `tokenHash` unique. `csrfToken`, `sessionVersion`, `remember`, `expiresAt`, `revokedAt`, `ip`, `userAgent`. No `lastSeen`. No TTL. |
| `models/CrmPasswordReset.js` | `crmPasswordResets` | `tokenHash` unique. `purpose` is `reset` or `invite`. 30-minute expiry checked at read. Used rows remain. |
| `models/CrmAuthAuditLog.js` | `crmAuthAuditLogs` | `createdAt` only. Actor may be absent on a login failure. No TTL. |

`models/Admin.js` is unchanged for CRM: `isSuperAdmin` and `sectionAccess`. Relevant keys are `consultancy-crm`, `consultancy-crm-manager` (`constants/crm.js`), and `crm-access-management` (`constants/crmUsers.js`). Admin login signs `{ adminId }` with `ADMIN_JWT_SECRET` and `ADMIN_JWT_EXPIRES_IN` or 24 hours. The token is a Bearer header. There is no server-side admin session.

Role templates: administrator gets all 18 permissions; manager gets the data permissions, including `crm.referrals.correct_source`, and no user-admin permissions; viewer gets every permission ending in `.read`. The request check uses the stored array, not the role name. A privileged account holds `crm.users.update`, `crm.users.deactivate`, and `crm.roles.manage`. The last such active account cannot be demoted or deactivated (`409 last_privileged_account`).

### Routes mounted in `server.js`

| Mount | Gate |
|---|---|
| `/api/crm-auth` | None at the mount. `GET /me` uses `requireCrmSession`. |
| `/api/crm/users` | `requireCrmSession`, then `requireCrmPermission` per route. Mounted before `/api/crm`. |
| `/api/crm` | `requireCrmSession`, then `crmPortalGate`. |
| `/api/admin/crm-users` | `requireAdmin`, then `requireAdminSection('crm-access-management')`. Super admin bypasses the section list. |
| `/api/admin/crm` | `requireAdmin`, then `requireAdminSection('consultancy-crm')`. Source correction also requires `consultancy-crm-manager` unless `isSuperAdmin` is true. |

`/api/crm-auth`: `POST /login`, `POST /logout`, `GET /me`, `POST /forgot-password`, `POST /reset-password`.

Account routes, on both user mounts: `GET /summary`, `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `POST /:id/activate`, `POST /:id/deactivate`, `POST /:id/reset-password`, `GET /:id/audit`.

Business routes, shared by `/api/crm` and `/api/admin/crm` via `routes/crmRoutes.js`: consultancies and contacts, students, referrals, `POST /referrals/:id/source-correction`, `GET /audits`, `GET /analytics`, `GET /calendar`. `DELETE /consultancies/:id` is 405. `DELETE` on a contact deactivates it. `PATCH /referrals/:id` is always 403 `referral_source_immutable`.

Portal permission map is `permissionForCrmRequest` in `constants/crmUsers.js`. An unmapped `/api/crm` path is 404 from `crmPortalGate`. `/api/admin/crm` does not use that gate. `crm.dashboard.read` has no route.

Pagination for every list, including audits and account audit: `page` and `limit` are required. `limit` above 100 is 400 `invalid_query`. There is no default page size (`utils/crmHttp.js`). `listAudits` returns every business audit, newest first, with no entity or actor filter. Account audit is filtered by `targetUserId`.

### Transactions and actors

`utils/crmMutation.js` `commitWithAudit` runs the mutation and the business audit in one Mongo transaction. Callers pass `requireTransaction: true`. If the server cannot start a transaction, the write fails with 503 `transaction_required` and does not fall through. Student-plus-referral create is one transaction with both audits, or neither.

Business audit actor comes from `auditActor` in `services/crm/fields.js`: a CRM session (`actorType === 'crm-user'`) stores `actorCrmUserId`; an admin stores `actorAdminId`. The validator on `CrmAuditLog` requires at least one of those ids. `createdBy`, `updatedBy`, and `sourceCorrectedBy` are still `ref: 'Admin'`, and the services write `actorId` into them. A CRM user id can therefore land in an Admin ref. The audit row itself is correct.

Account changes do not use `commitWithAudit`. `services/crm/crmUserAdminService.js` saves the user, optionally issues a reset token, then calls `writeAuthAudit`. `writeAuthAudit` is `CrmAuthAuditLog.create` with no session. A failed audit insert leaves the account change in place. Login, logout, and password reset in `services/crm/crmAuthService.js` have the same split.

### Sessions, as implemented

Cookie `gx_crm_session` is HttpOnly. `gx_crm_csrf` is not. `SameSite=Lax`. `Secure` only when `NODE_ENV=production`. Remember-me: cookie `maxAge` and `expiresAt` are 14 days. Otherwise the cookie is a browser session cookie and `expiresAt` is 12 hours (`services/crm/crmCookies.js`). `requireCrmSession` does not extend `expiresAt`. There is no refresh route.

Rejection codes: missing cookie `authentication_required`; unknown hash `invalid_token`; `revokedAt` or `sessionVersion` mismatch `session_revoked`; past `expiresAt` `session_expired`; inactive user `account_inactive`; bad CSRF on a write `csrf_failed`. Deactivation and password change increment `sessionVersion` and set `revokedAt` on open sessions. The next request fails. Permission edits are read from the user document on the next request. Admin section changes apply on the next request because `requireAdmin` reloads `Admin`. An admin JWT cannot be revoked server-side before it expires.

Login lockout is 8 failures inside 15 minutes, then `lockedUntil` for 15 minutes, still returned as 401 `invalid_credentials`. The IP limiter in `crmLoginLimiter.js` is process memory (default 50 per IP and 8 per identifier per 15 minutes). `forgotPassword` returns 200 and `delivery: 'not_configured'` and does not create a token. Admin-issued reset tokens are returned in JSON (`delivery: 'admin_display'`). Email is not sent.

### Indexes and migration

`scripts/syncCrmIndexes.js` is the only script that loads these CRM models. The CLI calls `ensureCrmIndexes` (`createIndexes` only) after `assertSafeIndexTarget`. It refuses `NODE_ENV=production` and any URI that is not localhost, `127.0.0.1`, `0.0.0.0`, or `[::1]`. `ALLOW_CRM_INDEX_SYNC` does not allow a remote URI. `config/mongooseSafety.js` sets `autoIndex: false` for every non-local URI unless `ALLOW_REMOTE_AUTO_INDEX=1`. Deploying the models does not create Atlas indexes.

`syncCrmIndexes()` calls `Model.syncIndexes()`, which drops indexes that are not on the schema. Tests use that function. The CLI does not. No production migration was run.

### Demo owner preview (not a production rule)

`crmDemoStore.js` stores one `ownerId` on each consultancy. `reassignOwner` replaces that id, leaves `createdById` unchanged, and appends `consultancy.owner_reassigned` in browser storage. It returns 403 `role_required` unless `demoRole` is `super_admin`, and the error text says the preview is not authentication. `canSee` shows a consultancy when the preview role is `super_admin` or `ownerId` is the single demo actor. The production architecture canvas says the public demo is not imported and the demo manager flag is not authorization. Production models have no `ownerId`. The working-tree demo layout no longer passes `demoRole`, so the reassignment form does not render.

---

## B. Baseline checks

Run on 2026-10-24 against the dirty working trees. Application code was not modified to make a check pass.

| Check | Result |
|---|---|
| Backend `node --test --test-concurrency=1 test/crmPhase1.test.js test/crmUserAuth.test.js` | 37 tests, 36 pass, 1 fail, 0 skipped. About 7.7s. |
| Frontend `npm test` | 107 tests, 107 pass, 0 fail. About 0.35s. |
| Frontend `npm run lint` | Exit 1. 322 errors, 46 warnings. None of the reported paths are under `src/pages/crm-app`, `src/pages/crm-demo`, `src/pages/admin/crm`, or `src/utils/crm*`. Not fixed. |
| Frontend `npm run build` | Exit 0. Vite 7.3.1, 2889 modules, built in 4.72s. Chunk-size warning on `dist/assets/index-*.js` (about 4.6 MB). Browserslist data reported as 10 months old. |
| Frontend typecheck | No `typecheck` or `tsc` script. Not run. |
| Backend lint | No ESLint config and no lint script. Not run. |
| Backend typecheck | CommonJS, no TypeScript project. Not run. |
| Backend production build | No build script. The process is `node server.js`. Not run. |
| Backend `npm test` | Alias of `test:whatsapp-all`. Not run. It is outside this CRM baseline. |
| Production database | Not contacted. No migration, backup, or index sync. |

The failing test is `consultancies, contacts, search, and pagination` in `test/crmPhase1.test.js`. It expects create to return `pipelineStage: 'fresh'`. The working-tree consultancy service returns `undefined`. The committed schema and the committed test still define that field. This failure was not fixed.

### Schema and API inconsistencies

1. `pipelineStage` remains on `CrmConsultancy` with default `fresh` and an index. The dirty service omits it from the DTO, list filter, and `pipeline` counts. Admin and portal pages in the dirty frontend also stop sending it. The phase-1 test still requires it.
2. `createdBy`, `updatedBy`, and `sourceCorrectedBy` are Admin refs. CRM-user writes store a `CrmUser` id there. The audit row uses `actorCrmUserId`.
3. Consultancy and contact audits pass the Express `req` as `meta` and read `meta.userAgent`, which is not a request property. Student and referral audits use `requestMeta` and store the header.
4. Account mutations and `crmAuthAuditLogs` inserts are separate writes. Entity CRM mutations and `crmAuditLogs` inserts are one transaction.
5. `getStudent` returns soft-deleted students. List hides them. Nothing in the services sets `deletedAt`.
6. Expired and revoked sessions and used reset tokens have no TTL and no deletion job. Retention is unspecified in code.
7. Login rate limits and lockout counters are process-local.
8. `listAudits` cannot be filtered by entity or actor. The portal does not call `GET /api/crm/audits`. The demo audit page is local storage. Admin account activity is `GET /api/admin/crm-users/:id/audit` only.
9. Frontend `AdminLayout` treats every path starting with `/admin/crm` as allowed after login, including `/admin/crm-access`. The API still enforces the section key. Client checks are not authorization.

---

## C. Target architecture

Reuse what the repository already enforces. Do not add a second CRM API or a sixth business collection. Do not add models for assignment, presence, per-user analytics, or admission-status history in this phase. Those product rules are not in the architecture record.

### 1. CRM user identities — reuse `crmUsers`

Separate from `Admin`. Fields, indexes, and validation are the model and `crmUserAdminService` as they stand: email and username unique, role one of the three keys, permissions a subset the actor is allowed to grant, password hashed with bcrypt, status `active` \| `inactive` \| `invited`. A CRM user cannot grant a higher rank or a permission they lack, and cannot deactivate themselves. Soft-delete is not an API. Retention of inactive accounts is indefinite. No new field is proposed.

### 2. Sessions — reuse `crmSessions` and the cookie pair

Create on login. Fixed expiry: 12 hours, or 14 days when `remember` is true. No sliding extension. Logout sets `revokedAt` when the cookie and CSRF check succeed. Deactivation and password change bump `sessionVersion` and revoke open sessions. CSRF is required on non-GET portal calls. Expired and revoked rows stay. No TTL and no refresh route are proposed, because the current lifetime is the implemented rule.

### 3. Roles and permissions — two gates, both already server-side

Platform admins: Bearer JWT, `consultancy-crm` for `/api/admin/crm`, `consultancy-crm-manager` for source correction, `crm-access-management` for `/api/admin/crm-users`. `isSuperAdmin` bypasses section keys inside `requireAdminSection`. It does not apply to `crmPortalGate`.

CRM users: cookie session, then the stored `permissions` array. There is no super-admin bypass on `/api/crm`.

Changing either gate, or treating the demo `demoRole` / `demoManager` flags as authorization, is out of scope.

### 4. Consultancy assignment — no production model

The demo preview uses one `ownerId` and replaces it on reassignment. The architecture record does not adopt that preview. Production consultancies have no assignee. No assignment collection, field, or route is proposed until a product rule says whether production has one primary assignee or several, and whether students follow the consultancy owner.

### 5. Student and referral scope — global for authorized callers

`listStudents`, `listReferrals`, `getAnalytics`, and `getCalendar` have no assignee filter. Any caller who passes the existing gate sees the module. Scoping by owner would be a new rule. It is not added. Counsellor `GET /api/counsellor/students` remains a different collection (`students`) and is covered by the phase-1 test.

### 6. Business audit — reuse `crmAuditLogs`

Append-only at the API: `writeAudit` inserts, and entity services have no update or delete. Writes go through `commitWithAudit`. Reason length 10–500 is required only for source correction. Secret-like keys are stripped and strings are cut at 500 characters. List is `GET /audits` with required `page` and `limit` (max 100) and no filter. The schema is not immutable, and tests call `deleteMany`. No retention period is declared. No second audit collection is proposed.

### 7. Security events — reuse `crmAuthAuditLogs`

Actions already written include `crm_user.created`, `crm_user.invited`, `crm_user.updated`, `crm_user.deactivated`, `crm_user.reset_issued`, `crm_user.password_reset`, `crm_user.login_succeeded`, `crm_user.login_failed`, `crm_user.login_inactive`, `crm_user.logout`, `crm_user.reset_requested`, `crm_user.reset_completed`. Admin CRM section changes write `crm_permission.updated` and `crm_permission.revoked` on `crmAuditLogs` through `permissionAudit.js`, and those admin-user writes already use `commitWithAudit`. Account events do not. Phase 2 below is the change that aligns account events with that fail-closed pattern. No new event collection is proposed.

### 8. Presence and heartbeat — absent, not proposed

`lastLoginAt` is set on successful login. There is no heartbeat route and no `lastSeen`. The architecture record does not define an online threshold or a heartbeat interval. None is invented here.

### 9. Super Admin overview — reuse the account summary

`GET /api/admin/crm-users/summary` returns counts by status and role and five recent users, behind `crm-access-management` or super admin. `GET /api/admin/crm-users/:id/audit` is that account's auth events, same pagination rule. `GET /api/admin/crm/analytics` is global referral and current admission status, behind `consultancy-crm` or super admin. Per-user business analytics are not in the architecture record and are not proposed.

### 10. Indexes, migration, backup, rollback

Keep the unique indexes in section A. Do not run `scripts/syncCrmIndexes.js` against Atlas or with `NODE_ENV=production`. Do not call `syncCrmIndexes()` against a database that has extra indexes. Phase 2 does not add an index or a migration. Rollback of Phase 2 is a code revert. Existing rows stay valid because the HTTP contract and the collections do not change.

Backup of live CRM data is an operational step outside this repository. This audit did not take one and did not read production.

### Compatibility that must stay

- Public `/crm` remains the browser demo. Demo records stay out of MongoDB.
- `/api/admin/crm` remains the admin contract: Bearer JWT, section `consultancy-crm`, manager section for source correction, super-admin bypass, page size max 100, 405 on consultancy delete, 403 on referral patch, one referral per student, phone uniqueness including deleted rows, atomic student-plus-referral create.
- Admin JWT, `ADMIN_JWT_SECRET`, `requireAdmin`, and counsellor/BDA tokens stay as they are. CRM cookies are rejected on `/api/admin/crm`. Admin bearers are rejected on `/api/crm`.
- `crmUsers` stays a separate identity. Do not merge it into `Admin`.

---

## D. Decisions

| Question | Verdict | Why |
|---|---|---|
| Separate CRM identity from platform admins? | **Resolved. Separate.** | `constants/crmUsers.js`, `crmUsers` vs `admins`, and `crmUserAuth` test `admin and CRM credentials are not interchangeable`. |
| One primary assignee or many? | **Unresolved for production.** | The demo preview has one `ownerId`. The architecture record does not copy it into MongoDB, and it says the preview is not authorization. |
| Access after reassignment? | **Unresolved for production.** | In the demo, the previous owner loses `canSee` as soon as `ownerId` changes, and the creator id stays. Production has no reassignment. |
| Session expiry and revocation? | **Resolved by the current code.** | Fixed 12 hours or 14 days. No refresh. Deactivate and password change revoke immediately via `sessionVersion` and `revokedAt`. Permission and admin-section changes apply on the next request. Admin JWTs expire by time only. |
| Are activity events durable and queryable? | **Resolved for the current logs.** | Both logs are Mongo collections. Business rows are written in the entity transaction. Account rows are not. Business list is global and paginated. Account list is per user and paginated. Neither has a retention TTL. |
| Is admission-status history required? | **Not required.** | The architecture record says to keep the limitation until a history collection is approved. Analytics already says earlier statuses are not stored. `ADMISSION_DUPLICATE_POLICY` is a different, unimplemented phase-2 rule about duplicate applications. It is not a status timeline. |

`pipelineStage` on the consultancy API is a working-tree conflict, not a new product rule. The schema and `test/crmPhase1.test.js` still require the field. The dirty service and dirty portal omit it. Do not treat the dirty service as the contract, and do not revert it inside this audit.

---

## E. Implementation backlog

Phase 1 changed no application file. The lists below are the intended later edits. They avoid the dirty files in section A so uncommitted work is not overwritten.

### Phase 2 — fail-closed account writes (first safe task)

Put each CRM account change and its `crmAuthAuditLogs` insert in one transaction, using the same fail-closed rule as `commitWithAudit`. Success responses stay the same.

| | |
|---|---|
| Files | `services/crm/crmAuthAudit.js` (accept a session), `services/crm/crmUserAdminService.js`, `services/crm/crmPasswordResetService.js`, `services/crm/crmAuthService.js` (login, logout, reset completion), `test/crmUserAuth.test.js` |
| Depends on | Existing transaction helper and the in-memory replica set already used by the CRM tests. No frontend change. No model change. |
| Database | None. No new index. No production run. |
| Security | Keep CSRF, `sessionVersion` revocation, the last-privileged-account check, rank checks, and the admin section gates. Do not put account events on `crmAuditLogs`. |
| Tests | Forced audit failure rolls back create, update, deactivate, and password set. Unavailable transactions return 503 and leave the account. Existing `crmUserAuth` cases still pass. Do not edit `test/crmPhase1.test.js` to hide the `pipelineStage` failure. |
| Acceptance | User row and auth-audit row commit together or neither does. HTTP bodies and status codes on the success path are unchanged. `/api/admin/crm` behavior is unchanged. |
| Rollback | Revert those five files. No data migration. |

Do not include `services/crm/consultancyService.js`, `server.js`, or any frontend file in Phase 2.

### Later, only after a product rule exists

| Item | Blocker | Do not change yet |
|---|---|---|
| Assignment and list scoping | One owner versus many, and whether access drops immediately, are undecided. The demo preview is not the production rule. | No `ownerId` on `CrmConsultancy`. No assignment collection. |
| Presence | No interval or online definition in the architecture record. | No heartbeat route. No `lastSeen`. |
| Per-user analytics | Global analytics already exist. A per-user series was not specified. | No new aggregate route. |
| Admission-status history | Explicitly not required. | No history collection. Keep the analytics label. |
| `createdBy` Admin ref versus CRM user id | Needs a compatibility plan that does not rewrite live ids. | No production migration in the next task. |
| Consultancy `userAgent` and `pipelineStage` | Both sit in the dirty `consultancyService.js`. | Leave the uncommitted diff until the contract is chosen. |

### Frontend, after Phase 2 and still without new product rules

No frontend file needs to change for fail-closed account writes. When the working tree is reconciled, keep `/crm` on `browserCrmDemo`, keep `/admin/crm` on `crmApi.js`, and keep `/crm-app` on cookie sessions. Do not add assignment, presence, or per-user analytics UI before the product decisions in section D.

---

## F. Phase 1 completion

Documented here: actual branches and dirty files, the five business collections and the four identity collections, both authorization gates, baseline test and build results, the security boundary between demo and production, the reused target architecture, the unresolved assignment question, and the Phase 2 file list.

No application code was implemented in Phase 1.

The first safe Phase 2 task is the fail-closed account write in section E. It does not touch the dirty consultancy service, does not add a collection, and does not decide assignment.
