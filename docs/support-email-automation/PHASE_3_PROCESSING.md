# Phase 3 — Email processing pipeline

Phase 3 turns a message that Phase 2 has already stored into a support ticket. It does not replace Graph sync, webhook validation, or subscription recovery.

Processing is off until `SUPPORT_EMAIL_PROCESSING_ENABLED=1`. The route exists at `POST /api/cron/process-support-email` and is not listed in `vercel.json`, so a deploy does not start it.

## Data flow

1. Phase 2 ingestion writes `SupportEmail` and enqueues a `fetch` job (`services/supportEmail/emailIngestionService.js`, `services/supportEmail/queueService.js`).
2. `services/supportEmail/pipelineService.js` takes one active run lock on `SupportEmailRun` and claims jobs with the existing lease and claim token.
3. Fetch (`bodyProcessingService.js`) performs one read-only Graph `GET` for the message body, strips scripts and unsafe markup (`bodySanitizer.js`), and stores bounded text plus an HTML snippet on `SupportEmail`.
4. Attachments (`attachmentService.js`) list and download file attachments with Graph `GET`, check the signature (`attachmentValidation.js`), store accepted bytes in the private GridFS bucket `support_email_attachments`, and extract text.
5. Classification (`classificationService.js`) calls the existing OpenAI-compatible client. The model output is checked by `classificationSchema.js`. Low confidence, invalid JSON, and prompt-injection flags become manual review.
6. Ticket creation (`ticketService.js`) upserts `SupportTicket` on the existing conversation dedupe key and appends a `SupportTicketEvent`. It never sends a reply.
7. Sheets (`sheetsSyncService.js`) upserts a row in `SUPPORT_EMAIL_SHEET_ID`. A sheets error leaves the ticket in MongoDB and retries the sheets job.

A second worker cannot claim the same job: `claimJob` is an atomic `findOneAndUpdate` guarded by `claimToken`. A second cron invocation gets `skipped: lock_held` while the run lock is active. An expired lock can be taken over. Releasing a lock matches its `lockToken`, so a worker that lost the lock cannot clear the replacement.

## Attachment rules

Accepted signatures: PDF, PNG, JPEG, DOCX, and XLSX. Executables, HTML, SVG, generic archives, and macro-enabled Office files are stored only as a rejection code on `SupportEmailAttachment`. The email continues. Image files are stored, but pixel text is not read: the shared LLM client accepts text only. That gap is `image_text_extraction_unavailable`.

DOCX and XLSX are read from the ZIP central directory, so a streaming writer that leaves local sizes at zero and appends a data descriptor still extracts. ZIP64 is accepted only when the compressed size already fits in the downloaded file and the output caps. Inflation is asynchronous and zlib is given a maximum output length. Declared uncompressed sizes are ignored. A nested archive, an unsafe path, an encrypted entry, a spanned archive, or a macro entry is rejected. The email is kept and the attachment row stores only the rejection code. PDF text is taken from the text layer. A scanned PDF with no text layer is recorded as `pdf_text_unavailable` and does not drop the email.

Downloads use the Graph `$value` stream. A missing, zero, or oversized declared size is rejected before the stream starts. The stream stops once the declared size or the configured cap is passed, and the temporary file is deleted on every exit. A short stream is `download_incomplete` and retries. A transport failure retries the stage. A rejected file does not. The accepted bytes are held only up to that cap, then stored in the private `support_email_attachments` bucket.

## Retention

Raw GridFS bytes expire after `SUPPORT_EMAIL_ATTACHMENT_RETENTION_DAYS` (default 90). Extracted text expires after `SUPPORT_EMAIL_EXTRACTED_TEXT_RETENTION_DAYS` (default 180), which must be at least as long as the file retention. Temporary `gx-se-` files older than `SUPPORT_EMAIL_TEMP_MAX_AGE_MS` (default 1 hour) are removed.

`POST /api/cron/support-email-retention` requires the cron secret. It is a dry run unless `execute=1`, and it is not listed in `vercel.json`. Each run deletes at most the retention batch size and stops at the time budget. It keeps walking past protected rows, up to 20 batches or 500 rows, so old open tickets do not block expired closed ones. Bytes are deleted only for an email on a `closed` ticket when no non-closed ticket and no pending, claimed, or processing job references that email. Open, resolved, needs_review, and unlinked attachments stay. Extracted text stays until its own retention date even after the file is gone. A GridFS or metadata delete that fails leaves the record selectable for the next run. Deleting a missing GridFS file counts as success. Mailbox messages are not deleted.

## Execution window

`SUPPORT_EMAIL_MAX_DURATION_MS` defaults to 60000, matching the Vercel `maxDuration` in `vercel.json`. `SUPPORT_EMAIL_LOCK_MARGIN_MS` defaults to 15000. The batch budget is clamped below `maxDuration` by that margin. The run lock is at least `maxDuration + margin`, so a second invocation cannot start while the first one can still be running. A non-positive duration, a margin that consumes the whole window, a batch size outside 1–200, or text retention shorter than file retention is rejected with `unsafe_processing_config`.

## Sheet retries

Before appending, the sheets stage claims the sync job and looks up column A for the ticket number. One match is updated. A missing ticket number or two matching rows fails without appending. A second worker that arrives while the claim is held does not append. An append that succeeds and then crashes before MongoDB saves the row number is recovered by the lookup after the claim lease expires. The append itself is not treated as idempotent.

## Manual review

`SupportTicket.status` includes `needs_review`. Invalid model output uses category `other`, confidence `0`, and status `needs_review`. A confident category is stored only when the schema is valid, confidence is at least the threshold (default 0.80), and the prompt guard did not flag the message.

## Google Sheet columns

Ticket number, category, priority, status, summary, created time, and updated time. Requester address, phone, and student identifiers stay on the ticket and are not written to the sheet. The same ticket updates its stored row number instead of appending another row.

## Environment

Required before processing can do useful work:

- `SUPPORT_EMAIL_PROCESSING_ENABLED=1` to leave the disabled state.
- `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`. `SUPPORT_EMAIL_LLM_MODEL` overrides the model when it is set; the same API key and base URL are reused.
- `SUPPORT_EMAIL_SHEET_ID` for the sheets stage. `SUPPORT_EMAIL_SHEET_TAB` defaults to `Tickets`.
- `GOOGLE_SHEETS_CREDENTIALS_JSON` for the existing service account.

Optional limits, with the Phase 1 defaults when unset:

- `SUPPORT_EMAIL_BATCH_SIZE` (25)
- `SUPPORT_EMAIL_TIME_BUDGET_MS` (45000)
- `SUPPORT_EMAIL_STALE_LEASE_MS` (120000)
- `SUPPORT_EMAIL_MAX_ATTACHMENT_BYTES` (10485760)
- `SUPPORT_EMAIL_MAX_MESSAGE_ATTACHMENT_BYTES` (26214400)
- `SUPPORT_EMAIL_MAX_PDF_PAGES` (30)
- `SUPPORT_EMAIL_CONFIDENCE_THRESHOLD` (0.80)
- `SUPPORT_EMAIL_MAX_DURATION_MS` (60000)
- `SUPPORT_EMAIL_LOCK_MARGIN_MS` (15000)
- `SUPPORT_EMAIL_ATTACHMENT_RETENTION_DAYS` (90)
- `SUPPORT_EMAIL_EXTRACTED_TEXT_RETENTION_DAYS` (180)
- `SUPPORT_EMAIL_TEMP_MAX_AGE_MS` (3600000)
- `SUPPORT_EMAIL_RETENTION_BATCH_SIZE` (25)

Graph mailbox credentials remain the Phase 2 variables. Phase 3 only issues `GET` for messages and attachments.

`image_text_extraction_unavailable` means no image OCR dependency is configured. Do not point a new vision vendor at mail without a separate decision.

## Indexes

`scripts/ensureSupportEmailPhase3Indexes.js` plans the partial unique lock index `runKey_1_active_lock` on `supportemailruns` and `createdAt_1` on `supportemailattachments`. It is a dry run until `--execute`, and it refuses `NODE_ENV=production` and remote databases. The Phase 1 and Phase 2 indexes are unchanged.

## Tests

```text
node --test --test-concurrency=1 test/supportEmailPhase3.test.js test/supportEmailPhase3Hardening.test.js
```
