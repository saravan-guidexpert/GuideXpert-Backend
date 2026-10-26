# CRM rate-limit index runbook

This procedure adds one index to `crmRateLimits`:

`{ key: 1 }`, unique, with no partial filter. The index name is `key_1`.

That is the index declared by `unique: true` on `CrmRateLimit.key`. Remote databases do not build it on deploy, because automatic index builds are off for remote MongoDB URIs.

This procedure does not run itself. A green test suite does not prove the production database has the index. Do not use `scripts/syncCrmIndexes.js` or `Model.syncIndexes()` for this change. The assignment index has its own runbook, `docs/CRM_ASSIGNMENT_INDEX_RUNBOOK.md`, and must be run as its own approved command.

The script does not call `syncIndexes()`, does not drop any index, does not update or delete rate-limit documents, and does not write to any other collection. It does not print key values. Keys can contain account identifiers and client addresses.

## Before running

1. Take a backup of the target database and confirm the backup can be restored. Restoring that backup is the recovery path if the index build must be undone by restoring data. Dropping only `key_1` is the narrower rollback below.
2. Get explicit approval to create this one index. Approval for a general index sync is not approval for this command. Approval for the assignment index is not approval for this command.
3. Inspect the current indexes on `crmRateLimits` and the duplicate-key count. The script does both. If two documents share a `key`, including a missing `key`, stop. Do not delete or rewrite those documents to force the index to build. Decide the surviving document by hand, outside this script, and only with separate approval.
4. Confirm the database name you intend to change. The command refuses to run unless `--database` equals the database name in `MONGODB_URI`.

## Command

From `GuideXpert-Backend`, with `MONGODB_URI` pointing at the approved database:

```bash
CRM_RATE_LIMIT_INDEX_APPLY=1 node scripts/ensureCrmRateLimitIndex.js --database <database-name>
```

Without `CRM_RATE_LIMIT_INDEX_APPLY=1`, the process exits and changes nothing.

If any key is duplicated, the process prints the group count and the document ids, exits non-zero, and does not create or alter an index. The documents stay as they were. Fix them by hand, then run the command again.

If an index named `key_1` exists but is not unique, uses a different key, or has a partial filter, the process exits non-zero and leaves that index in place.

If any index on `{ key: 1 }` exists but is not unique or has a partial filter, the process exits non-zero and leaves that index in place.

If `{ key: 1 }` is already unique and has no partial filter, including under another name, the process creates nothing.

If the collection does not exist yet, the command creates the empty collection and the index. It still does not insert a rate-limit document.

A second successful run creates nothing.

## Verification

After the command prints `Created crmRateLimits.key_1.`:

- The index key is `{ key: 1 }`.
- `unique` is true.
- There is no `partialFilterExpression`.
- The index name is `key_1`.
- No rate-limit document was updated or deleted.
- No other index was dropped.

The script reads the index back and exits non-zero if that comparison fails. A failure after the build starts does not delete documents. The process prints a fixed failure line and the error code. It does not print the driver error text, because that text can contain a key.

## What the application does with this index

Production login and heartbeat limits count in `crmRateLimits` when `NODE_ENV` is `production`. A MongoDB error, including a duplicate-key error while two isolates insert the same new key, returns `503 rate_limit_unavailable` and does not allow the attempt. The index is what makes that race leave one document. Without it, two first inserts can both succeed and the count can stay under the cap.

These writes are single-document updates. They are not inside `commitWithAudit`. The index build does not require a multi-document transaction. CRM assignment, student, and session writes still do.

## Rollback

Do not drop `crmRateLimits`.

A later, separately approved change may drop only `key_1`. Dropping it removes the database guarantee that one rate-limit key has one counter. Login and heartbeat limiting then depend on per-document updates again, and concurrent first inserts can under-count. Do not drop it as part of this procedure. Do not drop any other index from this procedure.
