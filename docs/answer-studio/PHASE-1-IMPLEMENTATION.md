# Answer Studio — Phase 1

Phase 1 adds the MongoDB models, the admin section key, and the authorization shell for AI Answer Studio. It does not embed text, retrieve knowledge, or call the LLM.

Phase 2A later added super-admin knowledge CRUD. Those routes, `isTestData`, and the knowledge field limits are documented in `PHASE-2A-KNOWLEDGE-CRUD.md`. Example and prompt routes are still the 501 gate described below.

No production database command was run. No production deployment was performed. No prompts were seeded.

## Models and responsibilities

| Model | Collection | Responsibility |
|---|---|---|
| `AnswerStudioKnowledge` | `answerStudioKnowledge` | Factual source text for later retrieval. Embeddings stay empty until a later phase writes them. |
| `AnswerStudioExample` | `answerStudioExamples` | Approved question-answer pairs used later as writing-style guidance. |
| `AnswerStudioGeneration` | `answerStudioGenerations` | One generated answer. `rawAnswer` is immutable after insert. Edits go to `editedAnswer`. A later regeneration creates a new document and may set `parentGenerationId`. |
| `AnswerStudioPrompt` | `answerStudioPrompts` | Versioned platform instructions. Versions are inserted, not overwritten. |

These collections are separate from `KnowledgeChunk`, the counselling JSON file, WhatsApp prompts, website-chat prompts, and college-comparison prompts.

`contentHash` on knowledge is indexed and is not unique. The same text may be stored more than once when the source or the historical row should be kept. A global unique constraint would block that before a product rule exists.

## Field notes

Shared embedding rule on knowledge and examples:

- `embedding` is `[]` or exactly 1024 finite numbers.
- `embeddingDimensions` must be 1024, matching `services/ai/embeddingService.js` (`nvidia/llama-nemotron-embed-1b-v2`).
- Phase 1 does not call the embedding provider.

Example rules, enforced in a `validate` hook:

- `platform` is `quora` or `reddit`.
- `draft` and `archived` are stored with `active: false`. Setting `active: true` on those statuses is cleared before save.
- `approved` requires `approvedBy` and `approvedAt`.
- Only an approved example can remain `active`.
- Moving an approved example back to `draft` or `archived` clears `active` and keeps the previous approver fields.

Generation rules:

- `rawAnswer` cannot be changed through `save`, `updateOne`, `updateMany`, `findOneAndUpdate`, or `replaceOne`.
- `generationVersion` defaults to 1.
- `knowledgeReferences` and `exampleReferences` store the ids used for that generation. Nothing fills them in this phase.

Prompt rules:

- `{ key, version }` is unique.
- At most one document per `platform` may have `active: true`. That is a partial unique index named `answerStudioPrompts_one_active_per_platform`.
- `services/answerStudio/activatePrompt.js` deactivates the other active row for that platform, then marks the chosen version active. It is not exposed over HTTP.

## Index definitions

Mongoose schema definitions only. `config/mongooseSafety.js` forces `autoIndex` off for every remote MongoDB URI. Defining these indexes does not create them on Atlas. Do not run `createIndexes`, `syncIndexes`, or `ALLOW_REMOTE_AUTO_INDEX=1` for this module until a reviewed index change says so.

| Collection | Index |
|---|---|
| `answerStudioKnowledge` | `{ contentHash: 1 }` non-unique |
| `answerStudioKnowledge` | `{ active: 1, updatedAt: -1 }` |
| `answerStudioExamples` | `{ platform: 1, status: 1 }` |
| `answerStudioExamples` | `{ active: 1, platform: 1 }` |
| `answerStudioGenerations` | `{ createdBy: 1, createdAt: -1 }` |
| `answerStudioGenerations` | `{ platform: 1, status: 1, createdAt: -1 }` |
| `answerStudioPrompts` | `{ key: 1, version: 1 }` unique |
| `answerStudioPrompts` | `{ platform: 1, active: 1 }` |
| `answerStudioPrompts` | `{ platform: 1 }` unique, partial filter `{ active: true }` |

`answerStudioExamples` has no `createdAt` index. There is no list query yet.

## Authorization

Section key: `answer-studio`.

Backend allow-list: `constants/adminSectionKeys.js`.

Frontend allow-list: `src/constants/adminSectionAccess.js`, including the Admin group in the existing manage-admins checkboxes. There is no sidebar item and no `/admin/answer-studio` page.

Mount, before the generic `/api/admin` router:

`requireAdmin` → `requireAdminSection('answer-studio')` → `routes/answerStudioRoutes.js`

| Caller | `GET /api/admin/answer-studio/status` | `/examples`, `/prompts` |
|---|---|---|
| No token | 401 | 401 |
| Admin without `answer-studio` | 403 `section_forbidden` | 403 |
| Admin with `answer-studio` | 200. Management flags are false. Generation flag is true, meaning future generation routes stay on this section gate. | 403 Super admin access required |
| Super Admin | 200. Management flags are true. | 501. The gate passed. No example or prompt collection is read or written. |

`/knowledge` is no longer a 501 route. See Phase 2A. Example approval and prompt edits stay super-admin-only behind `requireSuperAdmin`.

Future generation history routes must stay on this mounted router. They must not be added to a public router or to `adminRoutes.js` without `requireAdminSection('answer-studio')`.

## Module layout

```
models/AnswerStudioKnowledge.js
models/AnswerStudioExample.js
models/AnswerStudioGeneration.js
models/AnswerStudioPrompt.js
routes/answerStudioRoutes.js
controllers/answerStudioController.js
services/answerStudio/constants.js
services/answerStudio/validateEmbedding.js
services/answerStudio/activatePrompt.js
```

`server.js` requires the router and the section-key constant. It does not change chatbot, CRM, college comparison, or `KnowledgeChunk` behavior.

## Tests

From `GuideXpert-Backend`:

```
node --test test/answerStudioModels.test.js test/answerStudioAuthorization.test.js
```

Model tests use `mongodb-memory-server` on localhost, where `autoIndex` stays on. That is a disposable database, not Atlas.

The backend `npm test` script remains the WhatsApp suite. These files are not added to it.

## Future Vector Search requirements

Not created in Phase 1. A later reviewed Atlas change needs two vector indexes, separate from `knowledge_vector_index`:

| Index target | Path | Dimensions | Filter |
|---|---|---|---|
| `answerStudioKnowledge` | `embedding` | 1024 | `active` |
| `answerStudioExamples` | `embedding` | 1024 | `active` |

Local MongoDB and the memory server cannot serve `$vectorSearch`. Similarity metric should match the existing knowledge index once that Atlas definition is confirmed. It is not recorded in this repository.

## Database migration considerations

- New collections only. No change to `KnowledgeChunk` or counselling documents.
- Remote `autoIndex` is off. Shipping the schema does not build indexes on Atlas.
- When an index migration is approved, build the Mongoose indexes explicitly against the intended cluster and record the command. Do not drop existing indexes as part of that work.
- The partial unique prompt index will reject a second `active: true` row for the same platform. Activate through `activatePrompt`, which clears the previous active row first.
- Empty embeddings are valid. A later embedding job must replace `[]` with a 1024-length vector and set `embeddingModel`. A wrong length fails validation.

## Known limitations

- Example and prompt URLs still answer 501. Knowledge CRUD is Phase 2A.
- There is still no import, embed, retrieve, or generate HTTP API.
- `activatePrompt` is callable from server code only.
- Token usage is still not returned by `OpenAiCompatibleProvider`. This phase does not change that provider.
- The admin UI can grant `answer-studio` from Manage Admins. The section has no page yet, so the grant has no screen until a later phase.
- `GET /status` reports permission flags. It does not load studio documents.

## Phase 2 prerequisites

- Keep using `embeddingService` and the existing admin middleware. Do not add a provider or a login.
- Add super-admin knowledge and example writes behind the routes that already call `requireSuperAdmin`.
- Generate embeddings only on create or update when the text changes. Leave retrieval and Atlas vector indexes for the phase that reviews them.
- Do not write studio rows into `KnowledgeChunk`. The counselling indexer deactivates source ids that are absent from its JSON file.
- Do not seed production prompts until the prompt text is reviewed.
- Generation HTTP, the answer editor, and the sidebar page stay out of scope until their phases.
