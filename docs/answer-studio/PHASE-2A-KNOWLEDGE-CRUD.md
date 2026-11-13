# Answer Studio — Phase 2A knowledge CRUD

Super Admins can create, list, read, update, and soft-deactivate factual knowledge records. The collection may be empty. This phase does not upload knowledge, generate embeddings, or call Vector Search.

No production database command was run. No records were seeded.

## Authorization

Mount remains:

`requireAdmin` → `requireAdminSection('answer-studio')` → `routes/answerStudioRoutes.js`

Every knowledge route then uses `requireSuperAdmin`.

| Caller | Knowledge routes |
|---|---|
| No token | 401 |
| Admin without `answer-studio` | 403 `section_forbidden` |
| Admin with `answer-studio` who is not a super admin | 403 Super admin access required |
| Super Admin | The handlers below |

`createdBy` and `updatedBy` always come from `req.admin`. A client value for either field is rejected.

## Endpoints

### Create

`POST /api/admin/answer-studio/knowledge`

```json
{
  "title": "Engineering College Selection",
  "body": "Information about selecting an engineering college.",
  "sourceLabel": "Admin Knowledge Entry",
  "category": "College Admissions",
  "tags": ["engineering", "college", "admissions"],
  "isTestData": false
}
```

`201` returns `{ success: true, data }`. `active` defaults to true. `isTestData` defaults to false. The embedding array is not accepted and is not returned.

Allowed fields: `title`, `body`, `sourceLabel`, `category`, `tags`, `isTestData`.

### List

`GET /api/admin/answer-studio/knowledge?page=1&limit=20&search=engineering&active=true`

An empty collection returns `200`:

```json
{
  "success": true,
  "data": [],
  "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 }
}
```

Query allowlist: `page`, `limit`, `search`, `category`, `tag`, `active`, `isTestData`, `sort`, `order`.

- `page` defaults to 1. Maximum 100000.
- `limit` defaults to 20. Maximum 100. Larger values are rejected.
- `sort` is `createdAt` or `updatedAt`. Default `updatedAt`.
- `order` is `asc` or `desc`. Default `desc`.
- `active` and `isTestData` are the strings `true` or `false`.
- `search` is a case-insensitive match on title, body, category, source label, and tags. Regex metacharacters are escaped. Maximum 200 characters.
- `category` and `tag` are exact matches after the same text normalization used on write.

The list payload omits the `embedding` array. `hasEmbedding` is true when a vector is stored.

### Read

`GET /api/admin/answer-studio/knowledge/:id`

Invalid ids return 400. Missing records return 404. The body includes the editable fields, hash, flags, and audit ids. It does not include the embedding array.

### Update

`PATCH /api/admin/answer-studio/knowledge/:id`

Allowed fields: `title`, `body`, `sourceLabel`, `category`, `tags`.

Omitted fields stay as they are. `isTestData`, `active`, `contentHash`, `createdBy`, embedding fields, and `_id` are rejected. `updatedBy` is set from the authenticated super admin.

If `title` or `body` changes, `contentHash` is recomputed and any stored embedding, `embeddingModel`, and `embedText` are cleared. `embeddingDimensions` stays 1024 so a later job can write a vector of the same width. No new vector is generated. A source-label or category edit does not clear an embedding.

### Soft deactivate

`DELETE /api/admin/answer-studio/knowledge/:id`

Sets `active` to false and updates `updatedBy`. The document stays. Calling it again returns 200 with `active: false`. Generation `knowledgeReferences` are not removed.

There is no physical-delete route.

## Validation limits

| Field | Rule |
|---|---|
| title | Required string, 1–200 characters |
| body | Required string, 1–50000 characters |
| sourceLabel | Optional string, 1–200 when present |
| category | Optional string, 1–100 when present |
| tags | Array of strings, at most 30, each 1–50. Duplicate tags are dropped case-insensitively. |
| isTestData | Boolean, create only |

Text is stored as Unicode NFC with trimmed, collapsed whitespace. Empty strings are rejected. Non-strings are rejected. Object keys that contain `$` or `.` are rejected. Unknown fields are rejected. Query values must be strings.

Errors use `{ success: false, message }` and do not include stack traces.

## Duplicate detection

`contentHash` is SHA-256 hex of `normalizedTitle + "\n" + normalizedBody`. Title alone does not make two records duplicates. Source, category, and tags are not part of the hash.

Before create or a factual update, the service looks up `{ contentHash, active: true }` on the existing non-unique `contentHash` index, excluding the current id on update. A hit returns:

```json
{
  "success": false,
  "code": "DUPLICATE_KNOWLEDGE",
  "message": "An active knowledge record with the same content already exists.",
  "existingId": "..."
}
```

The existing row is not overwritten. An inactive row with the same hash does not block a new active row. The index stays non-unique so those rows can coexist. Two concurrent creates can still both pass the check; a unique index was not added.

## Test data

`isTestData` defaults to false. A super admin must send `true` to mark a synthetic record. Update cannot change the flag, so a production row is not converted into a test row by a later edit.

List with `isTestData=true` or `isTestData=false`.

Future retrieval must exclude `isTestData: true` unless a super-admin tool explicitly asks for test records. This phase does not retrieve.

No seed script runs. No sample rows are written by the server.

## Embedding limitations

Phase 2A does not call `embedDocuments`, `embedQuery`, or the NVIDIA client. It does not create Atlas Vector Search indexes and does not read `KnowledgeChunk`.

Records are created with `embedding: []`. They are not vector-indexed. After a title or body edit, a previously stored vector is removed so the row cannot be searched as if it still matched the old text.

## Tests

From `GuideXpert-Backend`:

```
node --test test/answerStudioKnowledgeCrud.test.js test/answerStudioModels.test.js test/answerStudioAuthorization.test.js
```

The memory server is local. `npm test` is still the WhatsApp suite and does not include these files.

## Known limitations

- The knowledge collection can stay empty until content is uploaded through the API or a later reviewed import.
- There is no admin page.
- Example and prompt routes still return 501.
- Duplicate detection is check-then-insert, not a unique index.
- Invalid JSON is handled by the existing Express parser and the global error handler, not by a studio-specific message.
- Embeddings and retrieval are later phases.

## Phase 2B prerequisites

Phase 2B was not started. A later example-management phase can follow the same super-admin pattern on `/examples`, which is still the 501 gate. Do not generate embeddings in that work unless the phase explicitly includes it. Do not point retrieval at `isTestData: true` records by default.
