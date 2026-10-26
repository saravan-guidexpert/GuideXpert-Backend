# CRM assignment index runbook

This procedure adds one index to `crmConsultancyAssignments`:

`{ consultancyId: 1, crmUserId: 1 }`, unique, with `partialFilterExpression: { revokedAt: null }`.

That is the index declared on `CrmConsultancyAssignment`. Remote databases do not build it on deploy, because automatic index builds are off for remote MongoDB URIs.

This phase does not run the procedure. A green test suite does not prove the production database has the index. The index stays pending until someone with approval runs the command below against the target database.

The script does not call `syncIndexes()`, does not drop any index, and does not write to any other collection. The rate-limit index is a separate procedure in `docs/CRM_RATE_LIMIT_INDEX_RUNBOOK.md`. Do not run `scripts/syncCrmIndexes.js` as a substitute for either procedure.

## Before running

1. Take a backup of the target database and confirm the backup can be restored.
2. Get explicit approval to create this one index. Approval for a general index sync is not approval for this command.
3. Resolve duplicate active assignments by hand. An active row has `revokedAt: null`. Two or more active rows with the same `consultancyId` and `crmUserId` must be reduced to one active row before the index can be created. Do not delete a row unless that is the approved repair. Revoking the extra row is the usual repair.
4. Confirm the database name you intend to change. The command refuses to run unless `--database` equals the database name in `MONGODB_URI`.

## Command

From `GuideXpert-Backend`, with `MONGODB_URI` pointing at the approved database:

```bash
CRM_ASSIGNMENT_INDEX_APPLY=1 node scripts/ensureCrmAssignmentIndex.js --database <database-name>
```

Without `CRM_ASSIGNMENT_INDEX_APPLY=1`, the process exits and changes nothing.

If any active pair is duplicated, the process prints the pair count and the assignment ids, exits non-zero, and does not create or alter an index. Fix those rows by hand, then run the command again.

If an index on `{ consultancyId: 1, crmUserId: 1 }` already exists but is not unique or does not use the partial filter above, the process exits non-zero and leaves that index in place.

A second successful run creates nothing.

## Verification

After the command prints `Created crmConsultancyAssignments.consultancyId_1_crmUserId_1.`:

- The index key is `{ consultancyId: 1, crmUserId: 1 }`.
- `unique` is true.
- `partialFilterExpression` is `{ revokedAt: null }`.
- No other index was dropped.

The script reads the index back and exits non-zero if that comparison fails.

## After the index exists

Use accounts created for this check. Do not use a real student's record.

1. Assign a CRM user to a consultancy. A second active assignment for that same user and consultancy returns `409 duplicate_assignment`, and only one active row remains.
2. Revoke that assignment. Revoke clears every active row for that user and consultancy, including a duplicate left over from before the index existed. The user's next read of that consultancy is `404`. The index is still required: without it, a second active insert can commit beside a revoke that is already in flight.
3. Assign the same pair again. The new row is allowed because the revoked row has `revokedAt` set. The user can read that consultancy again.
4. A user assigned only to consultancy A receives `404` for consultancy B's consultancy, student, and referral routes.

## Rollback

Do not drop `crmConsultancyAssignments`.

A later, separately approved change may drop only `consultancyId_1_crmUserId_1`. Dropping it removes the database guarantee that one CRM user has one active assignment per consultancy. Do not drop it as part of this phase.
