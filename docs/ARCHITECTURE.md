# Architecture map (0.8.1)

Choose the smallest relevant source/test slice here. [Repair](REPAIR.md) starts from symptoms; [contracts](API-CONTRACTS.md) captures upstream assumptions. Paths in tables are relative to repository root. Source is authoritative.

## Runtimes

`npm start` → `src/server.js` → MCP stdio. Playwright APIRequestContext is the HTTP transport; Chromium is only fallback authentication/research. Ordinary API calls, workers, SHA and local polling do not call a model. MCP arguments/results still enter the calling model's context.

`npm run gallery -- JOB_ID` serves loopback on 8876 by default. Cleanup open/report tools call `ensureCleanupWeb` and reuse a compatible service. Detached inventory/verification/deletion workers outlive tabs and MCP connections, but require the machine/processes to remain running.

## Every source module and callers

| Source | Responsibility / entry points | Callers / checks |
|---|---|---|
| `src/server.js` | Tool schemas/annotations, account serialization, error envelopes, route allowlist and paid-route dispatch; `tool`, `routePath` | stdio client; read-only script, core/jobs/cleanup tests |
| `src/client.js` | Origin restriction, Inertia decode, CSRF, sessions, portable login modes, HTTP errors/no write retries; `authenticatedRead` shares one login/replay for expired reads, 30s failure cooldown | All API subsystems including media-source/thumbnail; `test/core.test.js`, `test/session-recovery.test.js` |
| `src/paths.js`, `src/state.js`, `src/errors.js` | Code/data separation, platform data directories, private atomic JSON and shared error type | All runtime modules; accounts/core tests |
| `src/accounts.js`, `src/vault.js` | Account schema, manual/native vault modes, pending failures, no plaintext fallback | CLI, client, auth helper; accounts tests |
| `src/auth-broker.js` | Private authenticated Unix socket / Windows pipe, memory-only unlock keys, login without returning passwords | CLI unlock/lock, encrypted client login; isolated broker tests |
| `bin/neurover.mjs`, `src/setup-config.js` | Local setup/settings/login/unlock/lock, masked input, MCP connection output | User terminal and setup tool; CLI/package checks |
| `src/update.js`, `scripts/launcher.mjs`, `scripts/install.mjs`, `get.sh`, `get.ps1` | Release check (GitHub tags, weekly, one notice per session), managed install `<dataDir>/app/versions/<v>` behind stable `app/neurover.mjs`, git fast-forward update, refusal while cleanup workers run. Built-ins only | Server startup, `neurover_update_*` tools, CLI `update`, one-line installers; update tests |
| `src/clients.js` | Adds `neurover` to Claude Desktop/Cursor/Windsurf JSON and Codex `config.toml` (section replaced in place) with `.bak-neurover` backup, and to Claude Code via `claude mcp add --scope user`; invalid JSON untouched | CLI `setup`/`connect`; update tests |
| `scripts/bundle.mjs`, `scripts/test.mjs` | Explicit release allowlist + shrinkwrap, isolated test data/legacy paths | Release and CI; staging/install checks |
| `src/browser-auth.js` | Isolated visible login, authenticated session capture and window lifecycle | server auth tools; real CAPTCHA untested |
| `src/routes.json` | Discovered route names/methods/paths, not verified payload definitions | server catalog/read/write; research evidence |
| `src/generation.js` | Live models/schema, prompt code-point limits, settings, references/multipart, quotes, draft claims | server generation tools, jobs draft/budget reuse; core tests |
| `src/jobs.js` | Run/enhancement quotes, graph fingerprint, budget, prepare/submit | server run/enhancement tools; `test/jobs.test.js` |
| `src/summaries.js` | Compact status/output/price/error/refund summaries | server generation tools; `test/summaries.test.js` |
| `src/media.js` | No-overwrite download, upload start/file, asset-node attach/reuse; `ensureMedia`, `upload` | server and generation references; core/dedup tests |
| `src/media-dedup.js` | Stable local fingerprint, original comparison, paginated library, index/pending recovery, process locks | media, generation, cleanup; `test/media-dedup.test.js` |
| `src/media-source.js` | HTTPS media stream, validated redirects, scoped cookies, MIME/errors | download, dedup/cleanup hashes, web proxy; core/dedup/web tests |
| `src/cleanup.js` | Scan/review/verify/approve/exact files/step/status/pause/cancel, frozen plan and reconciliation | server/web/three workers; `test/cleanup.test.js` |
| `src/cleanup-report.js` | Escaped HTML assembly, bounded thumbnails; `libraryGroups`, `renderReport`, `writeReport` | cleanup reports/web; cleanup/gallery/web tests |
| `src/cleanup-web.js` | Local routes/schemas, Host/Origin/token guards, lazy thumbnails, ETags, Range and bounded streaming | open/report tools and CLI; `test/cleanup-web.test.js` |
| `src/cleanup-scan-worker.js` | Detached saved inventory/dependency loop; stops on ready/error and persists reason | startScan after nextCleanup/resume; cleanup/web tests |
| `src/cleanup-worker.js` | Saved-plan loop, batch 10, bounded attention retry, graceful pause | `startCleanup` detached process; cleanup worker tests |
| `src/cleanup-verify-worker.js` | Selected-group SHA loop, byte budget, between-file pause, stalled-progress guard | `startVerification` detached process; cleanup worker tests |
| `src/cleanup-ui/shell.html` | CSP, semantic navigation/dialog skeleton, script injection markers | renderer; gallery tests |
| `src/cleanup-ui/gallery.css` | Native tokens, grid/breakpoints, dialogs/player/focus/reduced motion | renderer; design docs and browser review |
| `src/cleanup-ui/model.js` | Pure search/filter/sort/selection/retention/disposition/restore rules | app, Node gallery tests, synthetic fixture |
| `src/cleanup-ui/app.js` | Cards/viewer/keyboard/selection/review DOM, browser persistence | rendered page; gallery/media tests and browser review |
| `src/cleanup-ui/live.js` | Local operations/polling/progress/results/pause/resume/refresh/player lifecycle | rendered page after app; gallery/media/web tests |

## Execution paths

Read/auth: tool → account selection/`serial` → `clientFor` → `http`/`page` → JSON or decoded Inertia props. Non-GET needs CSRF; workflow mutation carries current version. MCP returns structured errors. Writes are not automatically retried.

Generation: resolve live model → ensure local reference once → media metadata (`mediaInfo`: access + library page `before_id=id+1`) → `compose` (`src/prompt-refs.js`: drop linkage-hidden settings, mode/field reference limits, `@ref_K`/legacy `@image_N` → site tile names, frame roles, expected geometry, warnings) → quote → private draft with `originalPrompt`, `referenceTable`, `expected`. `draftReport` is the shared transparency view (prepare and draft_view). Submit recomputes `compose` against the current model and refuses on any drift; after a successful POST `recordSubmission` writes `journal/<account>/<workflowId>.json` (requestId → final prompt, table, settings, expected). History/status/wait/download use it for `referencesSent` and `ORIENTATION_MISMATCH`. See [prompt-references-2026-11-01.md](prompt-references-2026-11-01.md). Submit validates account, age (10 min), model schema or graph fingerprint, fresh quote and ceiling, then exclusively creates `.claimed` before paid POST. A lost response keeps `request_uncertain`; recover by requestId/status. Preparation with a new local reference can upload it even though generation has not started.

Upload: stable fingerprint → account index lock → known ID/access or paginated original-byte comparison → pending journal before start → library route only (the canvas `/uploads/start` uploader that added an asset node was removed in 0.9.1). Library/chat (`neurover_ensure_media`, `filePath` references in `prepare_generation`; `ensureMedia` with `input.library={aiModelId,referenceField}` → `uploadToLibrary`): `/media-library/uploads/direct` (presigned PUT + complete) or multipart `/media-library/uploads`, no canvas node; the target model/field is resolved first (`ensureLibraryMedia`/`ensureReference`). A pending library attempt is resumed with the same `client_upload_id`; an old pending canvas attempt from earlier versions still blocks with `upload_pending` (inspect the workflow, never erase the journal).

Cleanup: pages of 50 per media type → cursor checkpoints → metadata candidate groups → dependency previews in batches of 10 → ready review. Metadata identity means MIME/bytes/dimensions/duration, not filename or preview. `j.items` holds all files; `j.groups` only candidate duplicate groups. Continue incomplete scanning with the same job ID.

Library: `?view=library` maps each `j.items` file once via `libraryGroups`, overlays known group metadata/protections and uses zero-padded hexadecimal asset IDs as explicit singleton group IDs. `?view=duplicates` uses `j.groups`. Explicit plans default to library mode. Library selects exact files including unique ones, without SHA or keep-one; duplicate mode retains SHA/metadata/retention. Both share the saved executor. The mode switch is live-only.

Approval/execution: duplicates choose hash/metadata and retention; hash splits identity sets and preserves singleton variants. Library chooses exact IDs. `approveFiles` requires ready inventory/current revision/no active verification/one active account operation. Its frozen plan uses mode explicit, `keepId=null`, `allowUsedOnCanvas=false`, metadata signatures. A step reconciles pending attempts first, relists metadata, checks keepers when relevant, previews dependencies, re-previews the safe subset, saves attempt/submitting states, then DELETEs. A receipt is not deletion: listing absence plus access absence confirm it. Pending/uncertain items block further destructive requests.

Next pass: nextCleanup locks a settled completed/cancelled parent, rejects pending/uncertain outcomes or another active account operation, creates one all-types child and saves nextJobId/previousJobId. Repeats return that child even when approved/running. startScan reuses a live scanner or resumes the same saved scanning job; status scanner/scanProgress and ETag drive UI progress/error/resume and ready reload. No selection/plan/SHA/deletion carries into the child.

## Persistent data

`root` is the code directory. `dataDir` comes from src/paths.js: explicit absolute NEUROVER_DATA_DIR, existing root/.data for backward compatibility, otherwise the OS user data directory. Child workers inherit the same environment. New installs never write data beside source. Private JSON uses temp + rename, directories 0700/files 0600. See [repair](REPAIR.md) before changing state manually.

| Path | Owner / meaning | Recovery boundary |
|---|---|---|
| `dataDir/accounts/<account>/session.json` | client cookie jar, independent of old MCP | Reauthenticate; do not print cookies; contexts are cached |
| same account `account.json` / `credential.json` | Mode/email and old credential files for migration | new passwords go to the OS store; settings writes manual/pending first, verifies native save/removal, removes the old file, then commits |
| same account `session-lock/` | Cross-process session save serialization | An old snapshot cannot overwrite a freshly captured session; next read imports fresh cookies |
| dataDir `auth-broker.json` | Private IPC address/PID/token, no password/key | Derived state; unlock starts helper, lock erases a key. Unix socket private / Windows token required |
| old MCP account `email` + Keychain service | login credentials source; override project with `NEUROVER_SOURCE_DIR` | Never copy passwords into logs/source |
| same account `media-index.json` | dedup v1 `assets` hashes and `pending` upload journals | Corruption fails closed; preserve pending UUID/node |
| same account `media-index.lock` | index owner PID/token | Dead-owner handling built in; no bypass |
| same account `cleanup-lock/media-index.lock` | shared cleanup lock using index lock helper | Serializes MCP/web/worker approval and steps |
| same account `cleanup-active.json` | active cleanup job pointer | Unfinished job blocks another approval |
| `dataDir/drafts/<token>.json` | prompt/settings/references/quote/requestId | Private; expired unclaimed draft needs new preparation |
| same draft `.json.claimed` | submitting/submitted/uncertain one-use claim | Never erase to retry a charge; inspect requestId |
| `dataDir/cleanup/<jobId>/job.json` | inventory/cursor/groups/hashes/review/frozen plan/attempts/results | Job source of truth; preserve and resume |
| same job `control.json` | graceful pause request | Does not cancel a sent DELETE |
| same job `scan-worker.json` | inventory PID/start/end/reason; links are in job.json | Status scanner/scanProgress; resume same child/cursor |
| same job `worker.json` | deletion PID/start/end/reason | Status checks liveness; start resumes same plan |
| same job `verification.json` | selected groups/retention/PID/start/end/reason | Resume selection; verification never approves deletion |
| same job `report.html`, `thumbnail-<id>.json` | derived report and preview cache | Regenerate report; previews never prove identity |
| `dataDir/cleanup-web.json` | web PID/port/default job/start | Check service health; operation token is per process |
| browser `neurover.cleanup.gallery.v1.<jobId>` | duplicate selection/retention/mode/density/revision | Local settings only, server plan wins |
| same browser key + `.library` | independent exact-file selection/density | View switch cannot widen duplicate scope |
| `research/`, `research/private/` | bundles/evidence and private account/session responses | Review public evidence before sharing; private responses stay private |

## Media and UI bounds

Live HTML embeds safe metadata/local endpoints without upstream URLs/cookies. First render is 48 cards; select-all spans all filtered matches and counts hidden scope. Thumbnail misses coalesce per job/asset, max four remote fetches; only Neurover thumbnail/poster endpoints and PNG/JPEG/WebP up to 256 KiB are cached. Selecting files or approving exact deletion does not fetch originals.

Player proxy: four upstream streams, backpressure/cancellation. Audio/video prefer access preview_url when available, with preload=none; image originals open on request. If upstream ignores Range, fallback discards/retransmits preceding bytes. SHA receives complete originals. Viewing/verification do not save whole originals, but browser buffering is possible; no total-memory guarantee.

Polling: 2.5s active, 10s idle; hidden tabs stop polling. Close/change clears media source; hide suspends and return reattaches without autoplay. Lost connection means last-known state, not stopped work. Completed plans remain frozen: after a settled operation, a new cleanup pass needs a fresh scan.
