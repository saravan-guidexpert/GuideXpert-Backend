# CRM Phase 8 — Security and production-readiness audit

Audit only. No application code, configuration, index, commit, push, or deploy was changed. The only file added by this phase is this report.

- **Date:** 2026-10-25
- **Node:** v24.21.0
- **Auditor method:** working-tree read of routes, middleware, services, models, and frontend routing; isolated in-memory tests; read-only `npm audit`; frontend lint and production build; unauthenticated probes of the already-running local API. No production database was contacted. No real session, password, token, or environment value is recorded here.

## 1. Executive summary and release verdict

**Verdict: NOT SAFE TO RELEASE**

The CRM session, permission gate, and consultancy-assignment checks are real server-side controls. A platform Admin JWT is not accepted as a CRM session. Ordinary CRM managers and viewers are scoped to their active assignments on list, detail, analytics, calendar, activity, and source correction. Those controls held in the isolated suites.

Two release blockers remain in the working tree that would ship:

1. **Confirmed high.** `PATCH` of an in-scope student's phone returns the full record of the student who already owns that phone, including a student outside the caller's consultancies. Create already redacts that record. Update does not.
2. **Confirmed high, operational.** The new assignment uniqueness rule exists only as a Mongoose index. Remote MongoDB has `autoIndex` forced off, and `scripts/syncCrmIndexes.js` refuses production and every non-local URI. Deploying this code does not create the index. Without it, two active assignment rows for the same user and consultancy can both be inserted, and a revoke updates only one of them.

The audited behavior also exists only as uncommitted work on both repositories. Current `HEAD` on either remote is not this system.

This verdict is about the working tree as reviewed locally. It is not a statement that a future build is safe, and it is not a production penetration test.

## 2. Scope, revisions, and working-tree baseline

Parent folder `/Users/venkatesh/Guidexpert` is not a git repository. The two apps are separate clones. Both working trees were dirty before this audit and were left in place. No reset, stash, discard, or reformat was run.

| Repository | Branch | HEAD | Remote tracking |
|---|---|---|---|
| `GuideXpert-Backend` | `feat/consultancy-crm-phase-1` | `c11c77144365be78b10f39909057739e5e0d491e` | Up to date with `origin/feat/consultancy-crm-phase-1` |
| `GuideXpert-Frontend` | `main` | `c1c30aba0f6ef99aa69b8c9a0b9ed900ed70b22f` | Up to date with `origin/main` |

HEAD messages: backend “Merge main so CRM sign-in can ship with the current production API.” (2026-10-24 13:26:50 +0530). Frontend “Restore the CRM demo top bar with the company name and workspace controls.” (2026-10-24 16:27:17 +0530).

### Backend working tree at audit start

Modified, unstaged: `constants/crmUsers.js`, `controllers/crmAuthController.js`, `controllers/crmConsultancyController.js`, `controllers/crmStudentController.js`, `controllers/crmUserAdminController.js`, `controllers/jeeMainMockTestController.js`, `models/CrmAuditLog.js`, `models/CrmAuthAuditLog.js`, `models/CrmSession.js`, `routes/crmAuthRoutes.js`, `routes/crmRoutes.js`, `routes/crmUserAdminRoutes.js`, `scripts/syncCrmIndexes.js`, `server.js`, `services/crm/analyticsService.js`, `services/crm/auditService.js`, `services/crm/consultancyService.js`, `services/crm/crmAuthAudit.js`, `services/crm/crmAuthService.js`, `services/crm/crmPasswordResetService.js`, `services/crm/crmUserAdminService.js`, `services/crm/referralService.js`, `services/crm/studentService.js`, `test/crmUserAuth.test.js`.

Untracked: `constants/crmPresence.js`, `docs/CRM_MULTI_USER_PHASE1_AUDIT.md`, `models/CrmConsultancyAssignment.js`, `services/crm/activityService.js`, `services/crm/crmAccess.js`, `services/crm/crmAssignmentService.js`, `services/crm/crmDirectory.js`, `services/crm/crmOperations.js`, `services/crm/crmPresence.js`, `test/crmActivity.test.js`, `test/crmAssignment.test.js`, `test/crmOperations.test.js`, `test/crmPresence.test.js`.

`git diff --stat` for the modified backend files: 24 files, 1187 insertions, 263 deletions. Nothing was staged.

### Frontend working tree at audit start

42 modified files (`git diff --stat`: 1084 insertions, 781 deletions) covering CRM routing, the portal layout, the demo shell, session and workspace clients, and `vite.config.js`. Untracked: `src/pages/admin/crm/workspace/`, `src/pages/crm-app/CrmAppIndex.jsx`, `src/pages/crm-app/CrmLegacyRedirect.jsx`, `src/pages/crm-demo/CrmDemoLegacyRedirect.jsx`, `src/utils/crmWorkspace.js`, `src/utils/crmWorkspace.test.js`.

### Phase reports that were available

`docs/CRM_MULTI_USER_PHASE1_AUDIT.md` is the Phase 1 baseline. Phases 2 through 7.2 were implemented in the same working trees (authentication transactions, assignments, activity, presence, operations, the admin workspace, and the move of that workspace into `/crm/app`). They did not leave separate markdown reports in `docs/`. This audit reviewed the resulting code and tests, not a second written report.

The configured MongoDB URI is present and points at a local host. `NODE_ENV` is unset in that environment file. `PORT` is `5050`. A backend dev server was already listening on port 5050. Probes below used that process. They did not log in, did not send a real password, and did not write CRM business data.

`npm audit` and the frontend build did not change `package.json` or lockfiles. `dist/` is gitignored. No source map files were emitted.

## 3. Architecture and trust boundaries

Three browser surfaces share one frontend origin and must stay apart.

| Surface | Browser route | Server credential | Data |
|---|---|---|---|
| Public demo | `/crm/demo` and legacy `/crm/<section>` redirects into the demo | None | `localStorage` key used by `src/utils/crmDemoStore.js`. Demo modules do not call `fetch`. |
| CRM portal | `/crm/login`, `/crm/reset`, `/crm/app/*` | HttpOnly cookie `gx_crm_session` plus header `x-crm-csrf` | `/api/crm-auth` and `/api/crm` |
| Platform Admin | `/admin/crm/*`, `/admin/crm-access` | `Authorization: Bearer` admin JWT | `/api/admin/crm` and `/api/admin/crm-users` |

`/crm` renders `<Navigate to="/crm/login" />`. `/crm-app` and `/crm-app/*` render `CrmLegacyRedirect`, which sends login and reset to `/crm/login` and `/crm/reset`, and other paths to `/crm/app`. Those redirects are client routes. They do not authorize an API call.

Server mounts in `server.js`:

| Mount | Middleware |
|---|---|
| `/api/crm-auth` | None at the mount. Session routes call `requireCrmSession`. Login, logout, forgot, and reset do not. |
| `/api/crm/users` | `requireCrmSession`, then `requireCrmPermission` per route. Mounted before `/api/crm`. |
| `/api/crm` | `requireCrmSession`, then `crmPortalGate`, then `routes/crmRoutes.js`. |
| `/api/admin/crm-users` | `requireAdmin`, then `requireAdminSection('crm-access-management')`. |
| `/api/admin/crm` | `requireAdmin`, then `requireAdminSection('consultancy-crm')`. |

`requireAdmin` accepts only a Bearer JWT signed with `ADMIN_JWT_SECRET` and reloads `Admin` on each request. `requireCrmSession` reads only `gx_crm_session`. A live `GET /api/crm/users` with `Authorization: Bearer not-a-crm-session` returned `401 authentication_required`. The isolated operations suite also asserts that a platform admin token is not a CRM session.

Permissions come from `req.crmUser.permissions` loaded with the session, or from `req.admin.sectionAccess` / `isSuperAdmin`. Request bodies are not a permission source. `assertActorCanGrant` refuses a CRM user who tries to grant a permission they do not hold. Role templates keep `crm.users.*` and `crm.roles.manage` on `crm_administrator` only.

**Ordinary CRM users** (manager and viewer templates) see business data only through active rows in `crmConsultancyAssignments`. Students and referrals follow the referral's current `consultancyId`. `originalConsultancyId` is attribution, not access.

**`crm.roles.manage` is global account administration.** Directory, presence, session history, and assignment create/revoke do not require the caller to already be assigned to the consultancy. An administrator can assign themselves and then read that consultancy through the normal business routes. That matches the Phase 7.2 workspace, which is gated on `crm.roles.manage`. It is not a bypass of the manager/viewer scope. It is a broader privilege than “assigned consultancies only,” and it should stay limited to that permission.

Platform admins with `consultancy-crm` see the whole CRM business module. `isSuperAdmin` skips section keys. It does not skip `crmPortalGate`, because that gate never runs on `/api/admin/crm`. Assignment scope returns early for non-CRM actors, so admin business reads are module-wide on purpose.

## 4. Endpoint authorization matrix

CSRF for CRM cookie routes is the session check in `requireCrmSession`: non-GET methods must send `x-crm-csrf` equal to the token stored on the session row. Logout repeats that check before it revokes a live session. Admin routes use a Bearer token, so the cookie CSRF check does not apply to them.

“Scoped” means a CRM actor is limited to active assignments. An admin actor is module-wide. “Global admin capability” means any caller who passes `crm.roles.manage` or the admin access-management section, including a CRM administrator with no current assignment.

### 4.1 `/api/crm-auth`

| Method and route | Auth | Permission | CSRF | Scope | Notes |
|---|---|---|---|---|---|
| `POST /login` | None | None | Origin allow-list when `Origin` is present. Missing `Origin` is allowed. | n/a | Generic `401 invalid_credentials` for unknown user, bad password, and lockout. Correct password on an inactive account returns `403 account_inactive`. Sets cookies only after the transaction commits. |
| `POST /logout` | Cookie if present | None | Required to revoke a live session | Own session | Always clears both cookies when the CSRF check passes or no live session is found. Live probe without a cookie: `200` and two clearing `Set-Cookie` headers. |
| `POST /heartbeat` | `requireCrmSession` | Any active CRM user | Yes | Own session only. Body `userId` / `sessionId` is `400`. | In-process rate limit. Does not extend `expiresAt`. |
| `GET /presence` | `requireCrmSession` | Any active CRM user | n/a | Own sessions | Returns that user's IP and user agent. |
| `GET /me` | `requireCrmSession` | Any active CRM user | n/a | Self | Refreshes the readable CSRF cookie. Live probe without a cookie: `401 authentication_required`. |
| `POST /forgot-password` | None | None | Origin check | n/a | Always the same `200` body. Does not create a reset token. Writes an auth audit only when the account exists. |
| `POST /reset-password` | Reset token in the body | None | Origin check, plus the token | That token's user | 30-minute expiry, single use of that one row, session version bump. |

### 4.2 `/api/crm/users` (CRM session)

| Method and route | Permission | CSRF | Scope |
|---|---|---|---|
| `GET /presence` | `crm.roles.manage` | n/a | Global account capability. Optional `consultancyId` is not checked against the caller's assignments. |
| `GET /directory` | `crm.roles.manage` | n/a | Global. Returns name, email, username, role, presence, and up to eight consultancy names. |
| `GET /summary` | `crm.users.read` | n/a | Global counts and five recent accounts. |
| `GET /` | `crm.users.read` | n/a | Global account list. DTO has no password hash. |
| `POST /` | `crm.users.create` | Yes | Global. Invite response includes `setupToken`. |
| `GET /by-consultancy/:consultancyId` | `crm.roles.manage` | n/a | Global. Unknown consultancy is 404 even when the caller is not assigned to it. |
| `GET /:id/sessions` | `crm.roles.manage` | n/a | Any CRM user. Includes IP and user agent. |
| `POST /:id/sessions/revoke-all` | `crm.users.deactivate` | Yes | Any CRM user. Auth audit in the same transaction. |
| `POST /:id/sessions/:sessionId/revoke` | `crm.users.deactivate` | Yes | Any CRM user. Auth audit in the same transaction. |
| `GET /:id/audit` | `crm.users.read` | n/a | That user's auth-audit rows. |
| `GET /:id/assignments` | `crm.users.read` | n/a | Service also allows a user to read their own assignments, but the route permission blocks managers and viewers. |
| `POST /:id/assignments` | `crm.roles.manage` | Yes | Any active user and any non-deleted consultancy. |
| `DELETE /:id/assignments/:consultancyId` | `crm.roles.manage` | Yes | Revokes one active row. |
| `POST /:id/deactivate` | `crm.users.deactivate` | Yes | Bumps `sessionVersion` and revokes open sessions. Self-deactivation is `409`. |
| `POST /:id/activate` | `crm.users.update` | Yes | Global. |
| `POST /:id/reset-password` | `crm.users.update` | Yes | Response includes `resetToken` for the caller to display. |
| `GET /:id` | `crm.users.read` | n/a | Any CRM user id. |
| `PATCH /:id` | `crm.users.update` | Yes | Role changes also require `crm.roles.manage` and `assertActorCanGrant`. Assignment and presence fields are rejected. |

### 4.3 `/api/crm` business routes

All of these require a CRM session and a matching `permissionForCrmRequest` rule. An unmapped path is `404` from `crmPortalGate` before the handler. State-changing methods require CSRF.

| Method and route | Permission | Scope |
|---|---|---|
| `GET /consultancies` | `crm.consultancies.read` | Assigned ids, then optional `q` and `status`. |
| `GET /consultancies/overview` | `crm.consultancies.read` | Assigned ids. Assignee names and roles for those consultancies are included (up to five). |
| `POST /consultancies` | `crm.consultancies.create` | Creator is auto-assigned inside the same transaction. Duplicate active name returns `409` and includes the consultancy only when the caller can already see it. |
| `GET /consultancies/:id` | `crm.consultancies.read` | Missing and out of scope are both `404 not_found`. |
| `PATCH /consultancies/:id` | `crm.consultancies.update` | Same `404`. Writes name, notes, and status only. |
| `DELETE /consultancies/:id` | `crm.consultancies.update` | Retention response. The handler does not delete the row. |
| `GET /consultancies/:id/contacts` | `crm.consultancies.read` | Consultancy access, then contacts of that consultancy. |
| `POST /consultancies/:id/contacts` | `crm.consultancies.create` | Same. |
| `PATCH /consultancies/:id/contacts/:contactId` | `crm.consultancies.update` | Contact must belong to that consultancy. |
| `DELETE /consultancies/:id/contacts/:contactId` | `crm.consultancies.update` | Deactivates the contact. |
| `GET /students` | `crm.students.read` | Students whose current referral consultancy is assigned. Search and admission filters are added on top of that id set. |
| `POST /students` | `crm.students.create` | With a consultancy id: access check, then student and referral in one transaction. Without one: an unscoped student is created. See F-04. |
| `GET /students/:id` | `crm.students.read` | `404` when missing, unreferred, or out of scope. Soft-deleted rows are still returned when a referral makes them in scope. |
| `PATCH /students/:id` | `crm.students.update` | Access check, then a field allow-list. Phone collision does not repeat the access check. See F-01. |
| `GET /students/:id/referral` | `crm.referrals.read` | Same student scope. |
| `GET /referrals` | `crm.referrals.read` | `consultancyId` and `studentId` are intersected with assigned consultancies. An out-of-scope consultancy filter becomes an empty page, not a `404`. |
| `POST /referrals` | `crm.referrals.create` | Student and target consultancy must both be in scope. A CRM user cannot attach a first referral to a student who has none, because student access itself requires a referral. |
| `POST /referrals/:id/source-correction` | `crm.referrals.correct_source`, checked again in the route | Current referral and target consultancy must both be in scope. |
| `PATCH /referrals/:id` | `crm.referrals.create` to reach the handler | Always `403 referral_source_immutable`. |
| `GET /analytics` | `crm.analytics.read` | Referral match limited to assigned consultancies. |
| `GET /calendar` | `crm.calendar.read` | Same. |
| `GET /operations` | `crm.analytics.read` | Assigned consultancies. Global presence totals are included only for `crm.roles.manage`. Students with no referral are counted only for module-wide admin actors. |
| `GET /audits` | `crm.audit.read` | Business audits for assigned consultancies, their contacts, current referrals, and those students. |
| `GET /activity` | `crm.audit.read` | Same business scope. Security rows for managers and viewers are assignment events for their consultancies. Account security events are included only when `canViewAccountSecurity` is true. |
| `GET /activity/summary` | `crm.audit.read` | Same filters. `limit` above 20 is `400`. |
| `GET /activity/:source/:id` | `crm.audit.read` | Loads the row only if it also matches the caller's filter. Out of scope is `404`. |

### 4.4 Platform Admin mounts

`/api/admin/crm-users` repeats the user-route table with the permission gate replaced by the access-management section. A section holder, or a super admin, can call every user route, including reset-token display, session revocation, and assignment.

`/api/admin/crm` repeats the business table without `crmPortalGate` and without assignment scope. Source correction adds `requireAdminSection('consultancy-crm-manager')` unless the caller is a CRM user who already passed `crm.referrals.correct_source`, or a super admin.

Client navigation is not the control. `AdminLayout` treats every path that starts with `/admin/crm` as allowed after login, which includes `/admin/crm-access`. The API still returns `403 section_forbidden` when the section key is absent. Live `GET /api/admin/crm/students` without a Bearer token returned `401`.

## 5. Data-isolation findings

What held, with test evidence from `test/crmAssignment.test.js`, `test/crmActivity.test.js`, and `test/crmOperations.test.js`:

- A manager assigned to consultancy A receives `404` for consultancy B's record, contacts, student, referral, and source correction, and the stored documents stay unchanged.
- After assignment revocation or account deactivation, the next request loses access.
- After a source correction, access follows the new consultancy. The original consultancy id remains on the referral and is not used for authorization.
- List search, analytics, calendar, operations, and activity detail use the same assignment set. Out-of-scope activity ids return `404`.
- Create-student phone collisions hide the other student's name and id (`duplicate_student` test assertion).
- Consultancy create auto-assigns the creator. A duplicate name hides the existing consultancy from a caller who cannot see it.

What does not hold:

- **F-01.** Update-student phone collisions return the other student.
- **F-04.** A student created without a consultancy id is outside every assignment. The creator receives it once, then cannot read it. Platform admins can. The phone remains globally reserved.
- **F-02.** Assignment isolation depends on a unique partial index that production deploy will not create.
- Overview for an assigned viewer includes co-assignee name, role, and status. That is limited to consultancies the caller is assigned to. It is recorded as design, not a cross-consultancy leak.
- A CRM administrator can list every account and every assignee without holding an assignment. That is the `crm.roles.manage` capability in section 3.

`GET` of a missing student and `GET` of an out-of-scope student both return `404` with a not-found message. The phone update is the response that distinguishes “someone else has this number” and then attaches their record.

## 6. Session, cookie, CSRF, and reset flow

Implemented behavior:

- Session cookie `gx_crm_session`: `HttpOnly`, `Path=/`, `SameSite=Lax`, `Secure` only when `NODE_ENV === 'production'`. No `Domain`, so the cookie is host-only.
- CSRF cookie `gx_crm_csrf`: not `HttpOnly`, same path and `SameSite`. The check compares the header with the session document, not with the cookie alone.
- Lifetimes: 12 hours, or 14 days when `remember` is true. `expiresAt` is not extended by later requests.
- Each request reloads the user. `revokedAt`, `sessionVersion` mismatch, expiry, and `status !== 'active'` all fail the request.
- Logout revokes the server row only after a matching CSRF header, inside `commitWithAudit`.
- Reset tokens are SHA-256 hashed, expire in 30 minutes, and `findOneAndUpdate` sets `usedAt` once. Password reset and admin password set bump `sessionVersion`.
- Login of an unknown identifier runs a dummy password compare and returns the same `401` as a bad password. Lockout (8 failures, 15 minutes, stored on the user) uses that same `401`.
- The in-memory IP and identifier limiter is 50 and 8 per 15 minutes per process, overridable by `CRM_LOGIN_MAX_IP` and `CRM_LOGIN_MAX_IDENTIFIER`.
- Heartbeat refuses a body that names another user or session, rate-limits per session id, and updates `lastSeenAt` only for the authenticated session row.
- Activity responses redact keys that look like passwords, tokens, cookies, and secrets. The isolated auth suite checks that reset tokens and session secrets are not stored in the auth audit.

Live local process (port 5050, `NODE_ENV` unset, so this is the development cookie shape, not a production capture):

| Probe | Result |
|---|---|
| `GET /api/crm/students?page=1&limit=20` with no cookie | `401 authentication_required`, no `Set-Cookie` |
| `GET /api/crm/users` with a Bearer token | `401 authentication_required` |
| `POST /api/crm/students` with a Bearer token and no cookie | `401 authentication_required` |
| `GET /api/crm-auth/me` with no cookie | `401 authentication_required` |
| `POST /api/crm-auth/login` from `Origin: https://evil.example` | `403 origin_forbidden`, no cookie |
| `POST /api/crm-auth/login` with no `Origin` and a nonexistent identifier | `401 invalid_credentials`, no cookie |
| `POST /api/crm-auth/login` from `Origin: http://127.0.0.1:5173` and the same nonexistent identifier | `401 invalid_credentials`, body keys `code`, `message`, `success` |
| `POST /api/crm-auth/forgot-password` for that identifier | `200`, no cookie |
| `POST /api/crm-auth/logout` with no cookie | `200`. Clearing cookies: `gx_crm_session` is `Path=/; HttpOnly; SameSite=Lax`. `gx_crm_csrf` is `Path=/; SameSite=Lax`. Neither cookie was `Secure`. |

The portal does not call `POST /api/crm-auth/heartbeat`. A search of `src` found no heartbeat client. `CrmSessionContext` calls `/crm-auth/me` on load and listens for `gx-crm-unauthorized`. Presence therefore stays idle for every open session until some other client heartbeats. Online, defined as a heartbeat inside two minutes, does not occur for the portal.

`safeCrmNext` accepts only `/crm/app` and its descendants, rejects `..`, backslashes, `://`, newlines, and paths longer than 300 characters. Frontend tests cover that helper. A browser walk of login, refresh, and back/forward was not performed.

## 7. Transaction and audit findings

`commitWithAudit` runs the mutation and the audit in one MongoDB transaction when the server can start one. Callers pass `requireTransaction: true`, so a standalone server returns `503 transaction_required` and does not fall through to a non-transactional write. The isolated auth, assignment, presence, and phase-1 suites include forced audit failures and confirm the business row is absent when the audit insert throws.

Covered together:

- Account create, update, deactivate, password set, login, logout, and reset completion, each with an auth-audit row.
- Assignment create and revoke, including the auto-assignment on consultancy create.
- Session revoke and revoke-all.
- Student, referral, consultancy, contact, and source-correction business audits.

Intentionally unaudited, and acceptable if documented:

- Heartbeats. They are frequent and do not change authorization.
- Successful and failed reads.
- `POST /forgot-password`, except the single auth-audit row when the account exists. No token is created. That audit insert is outside a transaction. A failed insert can turn a generic `200` into `500` only for an account that exists. That is a weak existence signal under a database fault, not the normal response.

Confirmed gaps:

- Consuming one reset token does not mark the user's other unused tokens used. Each token is single-use. A second token issued earlier still works until its own expiry. See F-05.
- Source-correction audits are stored on the referral. Activity scope uses the referral's current consultancy, so the consultancy that lost the student no longer sees the correction event. See F-08.
- Consultancy-create writes the assignment auth audit with the already-built request metadata object as the `req` argument. `requestMeta` then stores a null IP and user agent on that security row. The business audit for the same create stores them. See F-11.
- `GET /audits` returns stored `before` / `after`. Those values were passed through `sanitizeAuditValue` at write time. The activity API redacts again at read time. Current student snapshots store phone, city, and `emailPresent`, and a boolean `notesChanged`. They do not store note text or a password.

`createdBy`, `updatedBy`, and `sourceCorrectedBy` are still declared as Admin refs while CRM writes store a CRM user id. The audit row uses `actorCrmUserId`. That mismatch was already in the Phase 1 report and is still present.

## 8. Frontend and deployment findings

Route protection in the client:

- `/crm/app` is wrapped in `RequireCrmSession`. While `crmMe` is in flight the outlet is not rendered. Failure redirects to `/crm/login?next=...`.
- `CrmAppIndex` sends `crm.roles.manage` to the workspace and other users to the first section their permissions allow.
- Workspace pages call `workspaceRouteDecision` and do not fetch when the decision is forbidden.
- `useCrmResource` ignores a response that arrives after the effect is cancelled, and a failed response clears stored data (`crmWorkspace` tests).
- A `401` from `crmFetch` dispatches `gx-crm-unauthorized`, which drops the in-memory user. That path was not exercised in a browser.
- CSRF is kept in memory and read from the CSRF cookie. Login and access tests assert the session token is not written to `localStorage`. The demo theme key is separate.

Demo isolation held in source and in `crmDemoStore` tests: demo operations do not call `fetch`, and creating demo data does not select the API client. `/crm/demo` is outside `ProtectedAdmin`.

Production routing assumptions:

- `getApiBaseUrl` uses same-origin `/api` on localhost, `*.vercel.app`, and `guidexpert.co.in`.
- Frontend `vercel.json` rewrites `/api/:path*` to `https://gxp-new-backend.vercel.app/api/:path*`. The browser then talks to the frontend host, which is what makes a host-only `SameSite=Lax` cookie work.
- Vite's dev proxy sends `/api/crm-auth` and `/api/crm` to local port `5050` when the general proxy target is not already localhost. Other `/api` traffic defaults to `https://guide-xpert-backend.vercel.app`. Those are two different backend hostnames. The dev proxy is not part of the production bundle.
- Backend `vercel.json` sets `NODE_ENV` to `production`, which turns `Secure` on. The local process does not, and its logout cookies confirmed `Secure` was absent.
- CORS and the CRM origin check allow any `https://*.vercel.app` origin, any localhost port, and both `http` and `https` on `guidexpert.co.in`, with `credentials: true`. `SameSite=Lax` plus a host-only cookie prevents a cross-site script from attaching the session cookie. The allow-list is still wider than the deployed frontend. See F-09.
- There is no Content-Security-Policy on the frontend `vercel.json`. The CSRF cookie is readable by script on the frontend origin. Any XSS on that origin can call the CRM API as the signed-in user.
- The production build emitted no `.map` files. The main chunk is about 4.6 MB minified (`dist/assets/index-DNhKDEk-.js`).

Platform Admin CRM pages and CRM Access Management are still registered at `/admin/crm/...` and `/admin/crm-access`. The workspace UI moved to `/crm/app/*` and calls the portal client. There is no remaining `/admin/crm/workspace` route in `App.jsx`.

## 9. Test results

### Executed

Backend, isolated memory replica sets, no `.env` database:

```text
node --test --test-concurrency=1 \
  test/crmPhase1.test.js \
  test/crmUserAuth.test.js \
  test/crmAssignment.test.js \
  test/crmActivity.test.js \
  test/crmPresence.test.js \
  test/crmOperations.test.js
```

Result: **61 tests, 60 passed, 1 failed, 0 skipped.** Duration about 20.5s.

| Suite | Result |
|---|---|
| CRM activity timeline | 3 passed |
| CRM consultancy assignment isolation | 6 passed |
| CRM operations and directory | 4 passed |
| CRM session presence | 4 passed |
| CRM user authentication and access management, plus the permission-map test | 18 passed |
| Consultancy CRM phase 1 | 24 passed, 1 failed |

The failure is `test/crmPhase1.test.js:533`, assertion at line 536.

```text
AssertionError: Expected values to be strictly equal:
+ actual - expected
+ undefined
- 'fresh'
```

`consultancies, contacts, search, and pagination` stopped on that first assertion. Contacts, search, and pagination inside that one test did not run. Other phase-1 tests still covered phone uniqueness, referral concurrency, source correction, index refusal, and counsellor-student isolation.

Frontend:

```text
npm test
```

**113 tests, 113 passed, 0 failed.** Duration about 0.35s. Coverage includes login redirect safety, demo fetch isolation, workspace permission gating, and admin-route separation.

```text
npm run lint
```

Exit 1. **368 problems: 322 errors, 46 warnings.** Zero reported lines were under `crm-app`, `crm-demo`, `admin/crm`, or the CRM utils. This matches the Phase 1 lint baseline. It was not fixed.

```text
npm run build
```

Exit 0. Vite 7.3.1, 2902 modules, built in 4.24s. Browserslist data is reported as 10 months old. Chunk-size warning on the main bundle. No source maps.

Read-only dependency audit (`npm audit --json`, lockfiles unchanged):

| App | Critical | High | Moderate | Low | Total |
|---|---|---|---|---|---|
| Backend | 2 | 10 | 3 | 0 | 15 |
| Frontend | 1 | 19 | 4 | 1 | 25 |

Direct production packages named by the audit include backend `axios`, `mongoose`, `multer`, `sharp`, and `csv-parse`, and frontend `dompurify`, `jspdf`, `postcss`, `react-router-dom`, and `vite`. These are advisory counts. This phase did not build exploits for them, and it did not prove a CRM request reaches the vulnerable function. See F-15.

### Not run

| Check | Why |
|---|---|
| Backend `npm test` | That script is the WhatsApp suite, outside this CRM audit. |
| Backend lint, typecheck, and production build | No ESLint config, no TypeScript project, no build script. The process is `node server.js`. |
| Frontend typecheck | No `tsc` script. |
| Browser login, refresh, back/forward, logout, and expired-session UI | Not performed. Route structure and unauthenticated API responses were checked. |
| Production cookies, CORS, and HTTPS | Not performed against the deployed hosts. |
| Production or shared database | Not contacted. Index state in Atlas is unverified. |
| Authenticated cross-consultancy `PATCH` phone collision | Not executed, including against the local dev database. The return path is the source in F-01. The create path is what the assignment suite asserts. |

### Phase 1 regression

`test/crmPhase1.test.js:536` is still reproducible on this working tree. It is the same failure recorded in `docs/CRM_MULTI_USER_PHASE1_AUDIT.md`. The assertion was committed in `e9d3719f` (2026-10-24). `HEAD` of `services/crm/consultancyService.js` still returns and validates `pipelineStage`. The dirty service's `consultancyDTO` omits it, and `updateConsultancy` writes only name, notes, and status. A `PATCH` of `pipelineStage: 'hot'` is ignored and still saves, so the later assertion in that test (`400` for an unknown stage) would also fail if execution reached it.

The frontend working tree also stopped sending the stage. The schema default `fresh` remains on `CrmConsultancy`. Stored rows can still contain the field. The API no longer exposes or edits it.

This is a contract-test failure caused by uncommitted product code, not a security defect and not a failure introduced by this audit. It blocks a green CRM suite. It does not, by itself, block a security decision once the suite is updated to the current contract or the field is restored. Shipping with a known red test is still a release-process defect.

### Pre-existing versus new

The pipelineStage failure and the frontend lint totals predate this audit. F-01 was not introduced by this audit; it is untested behavior in the current update path. No application file was edited while the suites ran, so the results describe the baseline working tree.

## 10. Severity-ranked findings

### F-01 — High — Confirmed

**Student phone update returns another consultancy's student.**

- **Files:** `services/crm/studentService.js` `phoneConflict` (about lines 85–99) and `updateStudent` (about lines 302–307); `controllers/crmStudentController.js` `handle` (about lines 12–17).
- **Evidence:** `updateStudent` loads the other student by phone and throws `phoneConflict(other)` with no `assertStudentAccess`. `phoneConflict` puts `toStudent(existing)` on the error. The controller sends that object as `data`. `toStudent` includes `fullName`, `phone`, `email`, `city`, `notes`, `admissionStatus`, `createdBy`, and `updatedBy`. A soft-deleted owner instead returns `studentId` and `deletedAt`. `createStudent` uses `raisePhoneConflict`, which strips the record when the CRM actor cannot see that student. `test/crmAssignment.test.js` asserts the create response does not contain the hidden name or id. No test covers `PATCH`.
- **Abuse:** A manager or viewer with `crm.students.update` and one in-scope student sets that student's phone to a number used by another consultancy. The `409 duplicate_student` body contains the other student's counselling notes and contact details. Repeating with other numbers enumerates the global phone index.
- **Fix:** Use the same redaction as create. Return `409 duplicate_student` with no student payload unless `assertStudentAccess` succeeds. Do the same for the deleted-phone id. Add a two-consultancy test that `PATCH`es the hidden phone and asserts the body has neither the name nor the id, and that the in-scope phone is unchanged.
- **Verification:** In the memory-server assignment suite, create students on consultancy A and B, log in as a user assigned only to A, `PATCH` A's student to B's phone, and assert `409`, no PII, and both stored phones unchanged.

### F-02 — High — Confirmed mechanism, production index state unverified

**Assignment uniqueness is not created by deploy, so one revoke can leave access in place.**

- **Files:** `models/CrmConsultancyAssignment.js` unique partial index on `{ consultancyId: 1, crmUserId: 1 }` where `revokedAt` is null; `services/crm/crmAssignmentService.js` `revoke` uses `findOne` and updates that one row; `config/mongooseSafety.js` forces `autoIndex: false` for every remote URI; `scripts/syncCrmIndexes.js` throws when `NODE_ENV` is `production` or the URI is not local.
- **Evidence:** The phase-1 suite passes “indexes are unique and the sync script refuses remote targets” because tests call `syncIndexes` on the memory server. A normal Atlas deploy does not. Two inserts can both succeed when the index is absent. Revoke then clears one row. `assignedConsultancyIds` treats any remaining `revokedAt: null` row as access.
- **Abuse:** A double-submitted assignment, or two concurrent assigns, leaves a second active row. The administrator sees a successful revoke. The user keeps the consultancy.
- **Fix:** Before assignment writes are enabled in production, create the declared indexes with an additive, reviewed command. Do not run `Model.syncIndexes()` against production; the script comments already say that drops undeclared indexes. Keep the production refusal until that procedure exists. Add a test that two active rows cannot be inserted when the index is present, and that revoke of the only active row removes access.
- **Verification:** On an isolated replica, drop the assignment index, insert two active pairs, revoke once, and show the user can still read the consultancy. Recreate the index and show the second insert fails with `duplicate_assignment`.

### F-03 — Medium — Confirmed

**Creating a student confirms that a phone exists outside the caller's consultancies.**

- **Files:** `services/crm/studentService.js` `raisePhoneConflict`.
- **Evidence:** Out-of-scope create collisions throw `409 duplicate_student` with the same message and no student object. The assignment test locks that redaction. The status and code still tell the caller the number is taken somewhere in the CRM. Missing students on `GET` do not reveal that.
- **Abuse:** A user with `crm.students.create` learns whether a mobile number is already a CRM student.
- **Fix:** If product policy is to hide cross-consultancy existence, return the same `409` only after the caller could have seen the student, or use one generic conflict that is also used for other duplicate cases the caller cannot distinguish. If the existence signal is accepted, document it and still fix F-01.
- **Verification:** Extend the existing create assertion so a chosen policy is explicit: either the `409` remains and is documented, or the caller receives a response that does not distinguish an out-of-scope number from a validation failure. Do not weaken F-01's payload check.

### F-04 — Medium — Confirmed

**A CRM user can create a student who belongs to no consultancy.**

- **Files:** `services/crm/studentService.js` `createStudent` when `referralRequested` is false; `services/crm/crmAccess.js` `assertStudentAccess`.
- **Evidence:** The create transaction inserts a student and a `student.created` audit with no referral. Later `GET` and `PATCH` call `assertStudentAccess`, which `404`s when no referral exists. `POST /referrals` also requires student access, so a CRM user cannot attach the first referral. Platform admins can see the row. The phone stays unique. The demo store refuses a student without an active consultancy; the API does not.
- **Abuse:** A manager reserves phone numbers and leaves rows that only module-wide admins can see. Those rows are also the hidden side of F-01 and F-03.
- **Fix:** Require an in-scope active consultancy on CRM-actor student create, and create the referral in the same transaction. Keep the admin path only if unreferred students are an intentional admin workflow.
- **Verification:** `POST /api/crm/students` without `consultancyId` as a manager returns `400 consultancy_required` and inserts nothing. The same call with an assigned consultancy returns the student and a referral, and a later `GET` succeeds.

### F-05 — Medium — Confirmed

**Unused reset tokens stay valid after another token is consumed.**

- **Files:** `services/crm/crmPasswordResetService.js` `consumePasswordToken`; `services/crm/crmAuthService.js` `resetPassword`.
- **Evidence:** Consume updates the single matching hash. It does not set `usedAt` on the user's other unused rows. Password change revokes sessions and bumps `sessionVersion`. It does not expire outstanding reset rows. The auth suite proves one token works once and an expired token fails. It does not issue two live tokens and use the second after the first.
- **Abuse:** An administrator displays a reset code, later issues another, and the first code still changes the password until its own 30-minute expiry.
- **Fix:** Inside the reset transaction, after the password is stored, mark every other unused token for that user used. Do the same when an administrator sets a password directly.
- **Verification:** Issue two tokens, consume the first, and assert the second returns `400 reset_invalid` and the password does not change again.

### F-06 — Medium — Confirmed

**The CRM portal does not send presence heartbeats.**

- **Files:** `routes/crmAuthRoutes.js` `POST /heartbeat`; no caller under `GuideXpert-Frontend/src`. `constants/crmPresence.js` defines online as a heartbeat within two minutes.
- **Evidence:** `CrmSessionContext` calls `/me` only. Login does not set `lastSeenAt`. Directory and operations classify a valid session without a recent heartbeat as idle. The users page copy says online means a heartbeat within two minutes.
- **Impact:** Operators cannot tell an in-use session from an abandoned one. “Online” stays empty for portal users. This is a monitoring failure, not an authorization bypass. Heartbeat authorization itself is correct and is covered by `test/crmPresence.test.js`.
- **Fix:** From the authenticated portal layout, `POST /api/crm-auth/heartbeat` on an interval longer than the 30-second write interval and shorter than the two-minute online window. Send the CSRF header. Stop on `401`.
- **Verification:** Sign in through the portal, wait for one interval, and read `GET /api/crm-auth/presence`. `state` is `online` and `lastSeenAt` is set. A second browser session for another user is unchanged.

### F-07 — Medium — Confirmed code, production traffic shape unverified

**Login and heartbeat limits live in process memory, and the app never sets `trust proxy`.**

- **Files:** `services/crm/crmLoginLimiter.js`; `services/crm/crmPresence.js` `heartbeatBuckets`; `server.js` has no `trust proxy`. Backend `vercel.json` runs `server.js` as a serverless function.
- **Evidence:** Buckets are module-level `Map`s. A new isolate starts empty. Account lockout is stored on `CrmUser`, so the 8-failure lock still applies across isolates. The IP cap does not. Without `trust proxy`, `req.ip` on a proxied host is the immediate peer, so audit IPs and the IP bucket can collapse to the platform address.
- **Impact:** Password spraying can try seven passwords per account on every isolate. A shared proxy IP can also make legitimate logins share one 50-request bucket on a busy isolate. Client IPs in session history can be wrong.
- **Fix:** Keep the MongoDB lockout. Put the IP and heartbeat caps in a shared store, or document a single long-lived process as a deployment requirement. If client IP is required, trust only the platform's hop and add a test that a spoofed forwarded header is ignored.
- **Verification:** Two processes, one account, nine failures split across them, and the account locks. A forged forwarded-for header does not change the stored session IP when trust is unset.

### F-08 — Medium — Confirmed

**The consultancy that loses a student also loses the correction audit.**

- **Files:** `services/crm/auditService.js` `businessAuditScope`; `services/crm/referralService.js` `correctReferralSource`.
- **Evidence:** Scope matches `crmReferral` and `crmStudent` rows by the referral's current `consultancyId`. After correction, those ids belong to the destination. The destination sees `before` and `after`, including the previous consultancy id. The source consultancy's later activity query does not include that event.
- **Impact:** The destination needs the correction record. The source consultancy has no remaining audit that the student was moved. This is an audit-visibility gap, not a leak to an unassigned user.
- **Fix:** Decide the retention rule. If the previous consultancy should see the move, include events whose `before.consultancyId` is in the caller's assignments even when `after.consultancyId` is not. Keep the student record itself on the current consultancy.
- **Verification:** Correct a referral from A to B as a user assigned to both. A's activity feed contains the correction. A's student `GET` is `404`. B's `GET` is `200`.

### F-09 — Low — Confirmed configuration, session theft not demonstrated

**Credentialed CORS and the CRM origin check allow a wide set of sites.**

- **Files:** `server.js` `isAllowedCorsOrigin`; `utils/crmOrigin.js`.
- **Evidence:** Allowed origins include configured `FRONTEND_URL`, `http` and `https` on `guidexpert.co.in` and its subdomains, every `https://*.vercel.app` host, and any localhost port. `credentials: true` is set. Cookies are `SameSite=Lax` and host-only, so a cross-site `fetch` from an attacker-controlled Vercel project does not attach the session cookie. A live login from `https://evil.example` returned `403 origin_forbidden`.
- **Impact:** The extra origins matter if `SameSite` or `Domain` is later relaxed, or if a subdomain on `guidexpert.co.in` is attacker-controlled. They are not a demonstrated session bypass today.
- **Fix:** In production, allow only the real frontend origins over `https`. Keep localhost on an explicit development flag.
- **Verification:** From a non-allow-listed origin, login returns `403`. From the production frontend origin, login can set a `Secure` cookie. A cross-site `fetch` with credentials does not receive `Access-Control-Allow-Origin` for an unknown host.

### F-10 — Low — Confirmed

**A correct password on an inactive account is distinguishable from a bad password.**

- **Files:** `services/crm/crmAuthService.js` `login`.
- **Evidence:** Unknown user and bad password return `401 invalid_credentials`. Inactive or invited with the right password returns `403 account_inactive`, including after the transaction commits. The auth suite expects the inactive result not to set a session.
- **Impact:** Someone who already has the password learns that the account exists and is inactive. The response does not reveal whether an identifier exists when the password is wrong.
- **Fix:** If the product requirement is a fully generic login error, return `401 invalid_credentials` for inactive accounts too, and keep the auth-audit row.
- **Verification:** Correct password on an inactive user and a wrong password on an active user return the same status and code. Neither sets `gx_crm_session`.

### F-11 — Low — Confirmed

**The auto-assignment security audit on consultancy create drops the client IP.**

- **Files:** `services/crm/consultancyService.js` create audit calls `writeAuthAudit(..., meta, session)`; `services/crm/crmAuthAudit.js` passes that argument to `requestMeta`.
- **Evidence:** `meta` is already `{ ip, userAgent }` and has no `req.ip` or `req.get`. The auth-audit row stores nulls. The business audit written just above uses `meta.ip` directly.
- **Fix:** Pass `req` into that `writeAuthAudit` call, or teach `writeAuthAudit` to accept a metadata object that already has `ip` and `userAgent`.
- **Verification:** Create a consultancy as a CRM user and assert the `crm_assignment.created` row has the request IP and user agent.

### F-12 — Low — Confirmed

**Operational limits that are present but loose.**

- Expired and revoked sessions, and used reset tokens, have no TTL and no deletion job.
- `parsePageLimit` caps `limit` at 100 and requires `page`, but `page` has no upper bound. A very large `skip` is a database cost.
- `express.json` accepts 15 MB bodies on every route, including CRM login. That limit exists for poster templates.
- Directory `presence=online|idle|offline` loads every matching user into memory and then slices the page (`services/crm/crmDirectory.js`).
- `GET /students/:id` returns a soft-deleted student when the caller can see the referral. List hides `deletedAt`. No current service sets `deletedAt`.
- **Fix:** Add TTLs or a retention job, cap `page`, give CRM auth routes a small JSON limit, and paginate presence in the database.
- **Verification:** `page=1000000000` is `400`. A CRM content-type request over the auth limit is `413`. A soft-deleted in-scope student is `404` on detail if that becomes the rule.

### F-13 — Informational — Confirmed, pre-existing

**`pipelineStage` test drift.**

See section 9. The working tree dropped the field from the DTO and from writes. The committed test still expects `'fresh'`. Security release does not depend on restoring the field. A green suite does.

### F-14 — Informational — Confirmed design

**`crm.roles.manage` and platform `consultancy-crm` are module-wide.**

Documented in section 3 so a later review does not treat global directory access as an IDOR. Ordinary manager and viewer templates do not hold these permissions, and `resolveAccess` refuses permissions outside the selected role.

### F-15 — Informational — Advisory, exploitability in CRM unverified

**Dependency audit totals in section 9.**

Notable direct packages: `mongoose` (`$nor` sanitizer and prototype pollution in update casting), `axios` (NO_PROXY SSRF and a `validateStatus` prototype issue), `multer` and `sharp` on the backend; `jspdf`, `dompurify`, `react-router-dom`, and `vite` on the frontend. CRM queries build explicit filters from parsed strings and ObjectIds. This audit did not find a CRM handler that passes `req.body` through `sanitizeFilter` or that uses the React Router RSC stream. `jspdf` is used by poster and certificate pages on the same origin, which matters because of the missing CSP in section 8. Treat these as patch candidates, not as confirmed CRM vulnerabilities, until a CRM or same-origin call path is demonstrated.

### F-16 — Low — Confirmed on the local process

**The running API is not in production cookie mode.**

`cookieSecure()` is true only when `NODE_ENV === 'production'`. The local environment leaves `NODE_ENV` unset. Logout cookies on port 5050 had no `Secure` attribute. Backend `vercel.json` does set `NODE_ENV` for Vercel. A production host that starts `node server.js` without that variable would send the session cookie on cleartext HTTP.

- **Verification:** Against the deployed HTTPS API, a real login `Set-Cookie` for `gx_crm_session` includes `Secure`, `HttpOnly`, and `SameSite=Lax`, and omits `Domain`.

## 11. Release blockers and operational prerequisites

Blockers before this working tree is released:

1. Fix F-01 and add the cross-consultancy `PATCH` test.
2. Fix F-02's deployment path. Do not enable assignment writes until the unique partial index exists in the target database.
3. Commit and review both working trees. Deploying current `origin/feat/consultancy-crm-phase-1` or `origin/main` does not deploy Phases 2–7.2.
4. Decide F-04. Unscoped students should not be creatable by CRM users if ownership is “current referral consultancy.”
5. Resolve the red phase-1 test by updating it to the current consultancy contract or by restoring `pipelineStage` on purpose. Do not delete the assertion to go green without that decision.

Prerequisites that need an explicit approval, and that this phase did not perform:

| Step | Why it needs approval |
|---|---|
| Create CRM indexes on the real database, including `crmConsultancyAssignments` `{ consultancyId: 1, crmUserId: 1 }` unique with `partialFilterExpression: { revokedAt: null }`, plus session `lastSeenAt` indexes. | `syncCrmIndexes.js` refuses production. `syncIndexes()` can drop indexes. Use additive `createIndexes` only, after duplicate preflight counts are zero. |
| Confirm the target MongoDB is a replica set. | Every CRM mutation calls `commitWithAudit` and returns `503` when transactions are unavailable. |
| Set `NODE_ENV=production` on the API host. | Otherwise session cookies are not `Secure`. |
| Confirm the frontend rewrite target `gxp-new-backend.vercel.app` is the API that will contain this code. | The Vite dev default for non-CRM traffic is a different hostname, `guide-xpert-backend.vercel.app`. |
| Re-test login from the production site over HTTPS and confirm the cookie flags in F-16. | Local cookies were captured without `Secure`. |

Rollback: the assignment collection and the new routes are additive. Rolling back the process without the index is safe. Rolling back after assignments exist leaves unused rows. Do not drop the collection as part of a rollback unless a backup and a data decision exist.

There is no CRM health signal for authentication or authorization failures. Failures are JSON `code` values plus auth-audit rows for login failure, inactive login, and logout. `console.error` on session middleware logs the error message, not the cookie.

## 12. Recommended remediation order

1. **F-01.** Redact out-of-scope phone conflicts on update, including deleted-student ids. Add the two-consultancy `PATCH` test and re-run the six CRM files.
2. **F-04.** Require a consultancy on CRM student create so the phone index cannot be filled with invisible rows.
3. **F-05.** Invalidate sibling reset tokens in the same transaction as a successful reset or admin password set.
4. **F-02.** Write the approved additive index procedure. Run it on a copy first. Only then deploy assignment routes.
5. **F-06.** Send portal heartbeats and verify online versus idle with two sessions.
6. **F-07 and F-09.** Shared login limits, a deliberate proxy-trust decision, and a production origin allow-list.
7. **F-08 and F-11.** Keep the source-correction event visible to the previous consultancy, and store the client IP on the auto-assignment audit.
8. **F-13.** Update `test/crmPhase1.test.js` to the consultancy contract you intend to ship, then re-run it to completion so contacts, search, and pagination in that test actually execute.
9. **F-12, F-15, F-16.** Retention, body limits, dependency patches, CSP, and a production cookie capture.
10. Browser pass, still against isolated data: `/crm` to login, `/crm/demo` with no CRM API calls, `/crm/app` refresh and back after logout, inactive user, revoked session, and the F-01 request.

After items 1–4 and a green CRM suite, the release decision can be reconsidered. It should still be “ready for release review,” not an unconditional production certification, until the index procedure has been run on the target database and the production cookie has been observed.
