# API contracts and drift boundaries (0.8.1)

These are source-consumed, observed shapes, not a complete Neurover server specification. Use [architecture](ARCHITECTURE.md) for ownership and [repair](REPAIR.md) for diagnostics. `src/routes.json` is a client-route allowlist: a route's existence does not prove its payload or live behavior. Current source/tests take precedence over this document.

## HTTP / MCP / Inertia

`client.http` accepts only relative paths on https://neurover.io; JSON is chosen by response content-type, otherwise successful HTML must contain entity-encoded `data-page="..."` JSON. `parsePage` returns that Inertia page; `page()` returns `props`. Consumed props include `auth.user`, `csrfToken`, `modelOptions`, `project`, `workflowSettings`, `creditBalance`, `subscriptionAccess`, and page-specific collections. Workflow JSON uses `workflow.version` and `workflow.graph.nodes`/edges as consumed by callers.

Writes include `X-CSRF-TOKEN`; versioned workflow writes include `X-Workflow-Version`. No HTTP write retry. Network failure on GET → `network_error`; on write → `request_uncertain`. 401/login props → `login_required`; 419 → `session_expired`, clears CSRF. Other non-2xx uses server code/message or `http_<status>` plus validation errors. HTML without Inertia raises `unexpected_response`; malformed JSON is an error, not empty data.

Since 2026-10-17, authenticated GETs recover login_required/session_expired with one saved-credential HTTP login and one replay. Media GET/HEAD and thumbnail reads share this recovery, rereading cookies after login; same-origin 401/419 or login HTML/thumbnail login redirects trigger it. Concurrent reads share one login. Failed login or another unauthorized replay suppresses additional login attempts for 30 seconds. No POST/PATCH/PUT/DELETE is automatically replayed, and foreign media hosts never trigger a credential login. CAPTCHA, unavailable credentials and maintenance remain explicit failures, not bypasses.

MCP success/error content is JSON text. Errors set `isError=true`, with `{status,message,...details}`. Password/CSRF field names are scrubbed, but that is not a general redaction guarantee for arbitrary payloads. Compact generation responses omit full prompts and signed URLs by default; `details:true` is diagnostic/private.

## Inventory and media access

| Boundary | Consumed response/request | Fail-closed behavior / owner |
|---|---|---|
| GET `/media-library?type=...&limit=50&before_id=...&search=...` | `{items:[...],pagination:{has_more,next_before_id}}`; media fields id/name/media_type/mime_type/size_bytes/width/height/duration_seconds/available/source_kind/created_at/thumbnail_url/poster_url | Missing items/pagination or stalled cursor blocks scan/dedup; duplicate IDs de-duplicated; cleanup scan/media-dedup library |
| GET `/media-library/<id>/access` or workflow-scoped access | `{media:{id?,available,content_status?,mime_type,media_type?,download_url,preview_url?}}` | Absent/unavailable originals never substitute preview for byte hashes; access may omit metadata filled from inventory/index; media/dedup/generation |
| Original/preview fetch | HTTPS, valid redirects, image/video/audio or octet-stream response; cookies only for Neurover origin | Invalid URL/type/404/410/no body fails; media-source. SHA/dedup require complete original bytes |
| Thumbnail fetch | Same-origin `/media-assets/<id>/(thumbnail|poster)`, PNG/JPEG/WebP, ≤256 KiB | Missing/unsupported preview becomes placeholder; never download original as thumbnail fallback; cleanup-report |
| Upload start (not used since 0.9.1; it created a canvas node) | POST workflow `/uploads/start` with UUID/name/position/size/reference target; response `node.id`, `attempt_key`, or already-completed node | Journal UUID before request; unknown start outcome blocks reupload; media + dedup |
| Upload file (not used since 0.9.1) | Multipart `attempt_key`, file blob; resulting ID from asset.id or node primary/output asset fields | Uncertain result recovered via saved graph UUID/node and access/library; never blindly repeat |
| Library (chat) upload, as the chat «Прикрепить референсы → Загрузить» button (bundle `WorkflowDemoBanner`) | POST workflow `/media-library/uploads/direct` JSON `{client_upload_id,ai_model_id,reference_field,original_name,mime_type,size_bytes}` → `{asset,replayed?}` or `{available:true,upload:{url,headers,token}}` (PUT bytes, then POST `/direct/complete` `{client_upload_id,token}` → `{asset}`) or neither → multipart POST `/media-library/uploads` with `client_upload_id`, `ai_model_id`, `reference_field`, `file` → `{asset}` | Creates no canvas node. Used by `neurover_ensure_media` and `filePath` references in `prepare_generation`. Journal `client_upload_id` (mode `library`) before the request; resume only with the same ID (server replays by it). Payload inferred from the bundle 2026-11-01; not yet live-verified |

| Chat message store/preview | multipart `body` (plain text, `@image_N` literal), `settings[k]` minus linkage-hidden fields, `reference_asset_ids[field][]`/`reference_asset_roles[field][]` in order | Labels are client counters, not sent as mapping; MCP sends tiles 1..N per kind. Preview enforces `input_constraints` counts (422 `references.<field>`). Stored `input.references` is `[]` for field `images` (observed 2026-11-01) → local journal. Details: [prompt-references-2026-11-01.md](prompt-references-2026-11-01.md) |
| Media metadata by ID | GET `/media-library?type=<kind>&limit=1&before_id=<id+1>` returns that asset with width/height/size | Used for limit checks; access alone lacks dimensions |

Inventory metadata is not a cryptographic content proof. SHA-256 is over original bytes; equal previews, filenames, sizes or ETags are insufficient. Model file references require exactly one mediaAssetId/filePath, available media, and field/role accepted by current input schema.

## Deletion preview and execution

POST `/workflows/<workflowId>/media-library/deletion-preview` body `{media_asset_ids:[exact IDs]}` must return:

```json
{"preview":{"blocked":false,"requires_usage_confirmation":false,"items":[{"id":123,"name":"example.png","usages":[],"blockers":[]}]}}
```

`checkedPreview` requires both booleans, items array, exactly one result per requested ID, and usages/blockers arrays per item. Missing, duplicate, unknown or omitted IDs fail with `preview_schema_changed` / `preview_incomplete`. Preserve these checks when upstream changes shape; add observed fixtures before adapting. Execution also compares name/signature, rechecks retained copies, skips usages/blockers by default, and previews the final safe subset again.

DELETE `/workflows/<workflowId>/media-library` body `{media_asset_ids:[...],confirmed:true,response:"summary"}` expects arrays `deleted_ids` and `failures`; deleted IDs must belong to the submitted attempt. Failure IDs are read as `id` or `media_asset_id`; reason uses message/code. Unknown receipt schema raises `delete_response_changed` and keeps outcome uncertain. Receipt IDs alone never count as confirmed deletion.

The final preview checks each file's name, blockers and usages independently of aggregate flags. The attempt and submitting states are persisted before DELETE. Success moves nonfailed items to awaiting_confirmation; exceptions to uncertain. Reconciliation reads the full relevant library and access: only listing absence plus unavailable/missing access confirms deleted. Any unresolved pending state blocks the next DELETE. Current batch default 10, accepted range 1–50. Do not weaken these guards to accommodate a changed API.

## Quotes, generation and runs

Models come from workflow page `modelOptions`, identified by id/display_name/media_type with `input_schema_json` prompt max, defaults/options and reference constraints. Validate against the current schema, count prompt Unicode code points, fingerprint schema on prepare. Schema/graph changes invalidate prepared submission.

Model fields follow the site composer (bundle `WorkflowDemoBanner`, 2026-11-03). A field is a file field when `type==='file_array'`, or `type==='array'` and the key starts with `reference_` or declares `media_type`/`media_types`; names are not hardcoded (live examples: `images`, `reference_*`, Midjourney `cref`/`sref`). File fields are filled only through `reference_asset_ids[field][]`. The site never shows output-count keys (`prompt`, `count`, `n`, `max_images`, `quantity`, `output_count`, `numberOfRuns`, `sequential_image_generation`, `sequential_generation`, `multi_output`, `multiple_outputs`) or `disabled` fields as settings; MCP sends their defaults and refuses user values. Every attached file gets a composer tile `@<media_type>_N` by one counter per media type, whatever its field. Suno fields such as `audio_url`, `clip_id`, `continue_clip_id` are plain text on the site too (no upload handler in the bundle). Verified live 2026-11-03: Midjourney (id 108) with `cref`+`sref` priced and completed (4 images), the character from `cref` carried over.

Message price preview uses multipart `client_request_id`, `ai_model_id`, `body`, optional `price_quote_id`, `settings[key]`, and paired `reference_asset_ids[field][]` / `reference_asset_roles[field][]`. POST `/workflows/<id>/messages/price-preview`; while `status=pricing` and price_quote_id exists, GET `/price-quotes/<id>` for up to 30s. The source requires nonnegative safe-integer credits_minor and rejects failed/still-pricing/missing prices; it does not validate a complete quote-status enum. Do not infer stronger whole-response validation from this contract summary. Credits are hundredths; budget comparison uses integer minor units.

Run preview POST `/workflows/<id>/runs/preview` returns `preview.startable`, `nodes_to_generate` (pricing_status/price_quote_id/workflow_node_id) and `price_summary.suggested_budget.credits_minor`. Pending node quotes are polled then preview repeated; not-startable/missing budget blocks. Prompt enhancement price preview uses workflow/node path and the same completed quote requirements.

Every prepare yields a private 10-minute token. Submit rechecks account, one-use claim, current price not greater than prepared price, maxCredits and schema/graph. Message POST uses the multipart form; run POST uses client_request_id/max_budget_credits_minor, start_node_id/run_mode when scoped or confirm_all for full run; enhancement uses client_request_id/ai_model_id/price_quote_id. The claim is written exclusively before the request. Any lost result remains request_uncertain with requestId; never delete the claim or auto-repeat.

Status consumers accept message/node generation fields or latest_run.generation; compact summaries include status, generationFailed, error_code/error_message, processing/moderation/settlement fields, estimates/final credits and output IDs/types/dimensions/bytes. `failed`/`moderated` are failures, not absent results. Check requestId and existing message/run/enhancement before any replacement paid operation. Actual settlement is determined by Neurover, not the quote.

## Local gallery contract

Base origin is exactly `http://127.0.0.1:<port>`; default 8876. Host must match; foreign Origin/cross-site requests are rejected. POST needs matching Origin, X-Cleanup-Token from current HTML, application/json and strict schemas. Payload extras cannot widen scope. Error envelope is `{error:{code,message}}`; errors generally 409, forbidden 403, missing 404, schema 400, large body 413, range 416, media busy 429.

| Route | Payload / result |
|---|---|
| GET `/api/health` | service neurover-cleanup, version 0.8.1 |
| GET `/jobs/<jobId>?view=library|duplicates`, `/report.html` | safe HTML snapshot with local capability/token; invalid view rejected; explicit plan defaults to library |
| GET `/api/jobs/<jobId>` | compact status + updatedAt + plan mode/retentions/item states; scanner/scanProgress and previousJobId/nextJobId; scanner liveness participates in ETag/304 |
| POST same base `/verify` | unique nonempty groupIds (12 lowercase hex chars), optional groupRetention; starts verification only |
| POST `/delete` | groupIds/groupRetention, mode hash or metadata, confirmed:true, expectedUpdatedAt; metadata additionally riskAccepted:true |
| POST `/files-delete` | unique positive safe-integer mediaAssetIds (1–10000), confirmed:true, nonempty expectedUpdatedAt; approveFiles then same executor |
| POST `/new` | strictly empty object; settled completed/cancelled parent creates/reuses one linked all-types child; starts/resumes scan only while scanning |
| POST `/pause`, `/resume` | strictly empty object; pause graceful; resume scanning inventory first, otherwise plan or saved verification |
| GET/HEAD `/thumb/<id>` | own-job inventory/group file only; private cached thumbnail, lazy fetch/coalescing/max four upstream requests |
| GET/HEAD `/media/<id>` | own-job file only; fresh authenticated access, stream, single byte range, max four upstream streams |

Exact-file approval also validates account, ready inventory, current revision, no running verification, known IDs and account active operation under the shared lock. Repeating the exact frozen plan is idempotent; changing it raises plan_already_approved. Its explicit mode never means duplicate identity, never invokes SHA, has no keeper, and still protects canvas/server dependencies at execution. The local endpoint does not offer an allow-used override.

Report data contains id/account/status/updatedAt/scannedCount/reviewRetention/groups and limited plan item states. Each library group is explicit with one item; group IDs differ from numeric media IDs. Browser storage separates views. Local selection is not server approval. The offline HTML has no live capability; it retains manual handoff and embedded cached previews.

`neurover_cleanup_new(jobId)` shares nextCleanup/startScan. Under the account lock, parent must be completed/cancelled without pending/uncertain items; another active account job blocks first creation. Parent nextJobId/child previousJobId preserve history. Repeats return the child even when approved/running and never restart inventory. Errors: cleanup_not_finished/cleanup_busy. No deletion approval/SHA is granted. Scanner reports PID/liveness/reason and checkedDependencies/totalDependencies alongside scan phase/count.

## Evidence status

0.7 passed 107 tests and non-destructive real new-review validation; catalog 70 expected, not freshly measured.

Historical read-only checks: [2026-10-16](readonly-checks-2026-10-16.jsonl), 69 fresh-process tools / 12 successful read calls. Historical [live](live-checks.json), [quotes](quote-checks.json), [media](media-checks.json), [dedup](dedup-live-checks-2026-10-16.json) and [cleanup](cleanup-live-checks-2026-10-16.json) are observations, not comprehensive coverage. Live success/failure-refund generation evidence exists from earlier work; no new charge, real deletion or real SHA verification was made for 0.6 library acceptance. New/changed registry routes require their own payload evidence; never infer it from a successful catalog listing.

## Portable accounts (0.8.1)

CLI accepts no password/master in arguments, env or MCP. New settings permit manual/vault only. Native storage uses @napi-rs/keyring AsyncEntry, service neurover-api-mcp:ACCOUNT and email username; Linux requires Secret Service explicitly. Failed native reads return vault_unavailable without raw native errors. Missing record returns credentials_unavailable. Settings disable autologin first, save/readback or delete native credentials, remove old credential.json, then commit. Failure stays manual/passwordRemovalPending; vaultRemovalPending preserves a failed native cleanup across retries. No file fallback.

Old plaintext settings parse for migration but credentialsFor returns credential_migration_required. Old encrypted accounts retain private local unlock/login compatibility; no new encrypted records are configured. Legacy owner Keychain records remain untouched. Native save/delete tests use injected synthetic entries; actual macOS probe uses an isolated random record and deletes it.

Neurover password POST has maxRedirects:0, rejects foreign redirects, verifies email before accepting session. MCP setup/settings expose commands/mode only. Cookies still persist locally, independently of password mode. Test runner isolates state, bundle allowlist excludes all private state.
