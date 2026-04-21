# Learnings

## 2026-04-21T06:59:30Z Task: research-synthesis

- Repo is greenfield: only `.gitignore`, `.sisyphus/plans/discord-opencode-voice-mvp.md`, and local `.sisyphus` state exist; no source or package files yet.
- Reuse the plan itself as the primary architecture contract: thread↔session persistence, part-based OpenCode I/O, sequential per-thread processing, 2000-char Discord message cap, one active voice runtime per guild, and bot-message ignore rules.
- OpenCode guidance: use the official `@opencode-ai/sdk`; rely on `session.create(...)` and `session.prompt(...)`; always send user input as `parts`; normalize assistant output by message parts.
- Discord guidance: slash commands should ack quickly; thread creation and voice connection lifecycle should follow discord.js / `@discordjs/voice` patterns.
- Voice receive caveat: Discord audio receive is less stable/less officially guaranteed than send/playback, so runtime error handling and graceful degradation matter.

## 2026-04-21T07:08:21Z Task: package-manifest-bootstrap

- Selected runtime dependencies for bootstrap are `discord.js`, `@discordjs/voice`, `better-sqlite3`, `pino`, `dotenv`, `zod`, `undici`, and `@opencode-ai/sdk`, with `typescript`, `tsx`, and `@types/node` as the minimal TypeScript tooling.
- `@discordjs/voice@0.19.2` now requires Node `>=22.12.0`; `0.18.0` is the newest release that stays compatible with the repo's current Node 20 environment.
- `better-sqlite3@12.9.0` requires Node `20.x || 22.x || 23.x || 24.x || 25.x`, so SQLite support currently sets the manifest's minimum Node version.
- `undici@8.1.0` requires Node `>=22.19.0`; `undici@6.25.0` resolves cleanly on Node 20 and still satisfies the plan's generic HTTP/ASR client requirement.
- `npm install --package-lock-only`, direct JSON parsing, and `npm ls --package-lock-only --depth=0` all succeeded for the authored manifest.

## 2026-04-21T07:17:23Z Task: config-bootstrap-files

- `tsconfig.json` is now present and `npm run build` advances past the previous missing-file failure, so the package `build` script already aligns with the authored TypeScript config path.
- `.env.example` now documents the plan's required Discord bootstrap keys (`DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_MONITORED_CHANNEL_ID`) plus the current repo's guild-registration placeholder and OpenCode/ASR placeholders needed by later phases.

## 2026-04-21T07:20:42Z Task: repair-config-bootstrap-scope

- Restoring this task to config-only scope required deleting all previously added `src/*` bootstrap/source files and removing the stray `pino-pretty` dev dependency so the repo matches the earlier verified package-manifest baseline again.
- With only config artifacts left in scope, `npm run build` now fails solely with `TS18003` (`src/**/*` has no TypeScript inputs yet), which is the expected limitation until the next dedicated source-bootstrap task adds real compile targets.

## 2026-04-21T07:20:42Z Task: repair-config-bootstrap-scope-followup

- The later `Phase-0-bootstrap-files` notepad entry from the failed over-scoped attempt is historical noise only; it has been superseded by the scope-repair cleanup and should not be treated as the repo's current state.

## 2026-04-21T07:24:00Z Task: Phase-0-bootstrap-files

- Created all Phase 0 bootstrap files: `tsconfig.json`, `.env.example`, `src/app.ts`, `src/config.ts`, `src/types.ts`, `src/utils/logger.ts`, `src/utils/errors.ts`, `src/utils/time.ts`, and `src/register-commands.ts`.
- `npm run build` exits 0, config validation fails fast on missing env, and command registration bootstrap exists for `join` and `leave`.
- Added `pino-pretty` to devDependencies for logger dev transport.
- Fixed Zod 4.x API: use `.error.issues` instead of `.error.errors`.
- Simplified `src/types.ts` to remove unused imports.
- Config validation correctly exits 1 with message on missing required env vars.

## 2026-04-21T07:28:00Z Task: phase-0-source-bootstrap

- Added only the requested Phase 0 source modules: `src/app.ts`, `src/config.ts`, `src/types.ts`, `src/utils/logger.ts`, `src/utils/errors.ts`, and `src/utils/time.ts`; no extra bootstrap files were recreated.
- `src/config.ts` now validates the Discord bootstrap env contract at startup, while leaving later-phase OpenCode/ASR settings optional so the minimal bot skeleton can compile and boot within this task's scope.
- `npm run build` succeeds, and `node dist/app.js` with an empty environment exits with status 1 after a controlled `ConfigValidationError` instead of reaching Discord login.

## 2026-04-21T07:31:30Z Task: phase-0-source-bootstrap-repair

- Removed the out-of-scope `src/register-commands.ts` so the Phase 0 source tree is back to the six requested bootstrap modules only.
- Repaired `src/app.ts` to use the kept bootstrap API (`loadConfig`, `createLogger`, `setLoggerLevel`) instead of stale `config` and `logger` imports from the rejected earlier attempt.
- After the repair, `npm run build` succeeds and the built app still fails fast with a logged `ConfigValidationError` and exit code `1` when required Discord env vars are missing.

## 2026-04-21T07:38:22Z Task: discord-bootstrap-contract

- `src/config.ts` now owns the readable Phase 0 Discord capability contract for `mentions`, `threads`, `slashCommands`, and `voice`, then derives the concrete `GatewayIntentBits`, `Partials`, and `PermissionFlagsBits` arrays from those names for later reuse.
- `src/app.ts` now creates the Discord client from `config.discord.requirements` and logs the resolved intent/partial/permission names on ready, keeping the bootstrap contract visible without adding any command, thread, or voice runtime behavior.
- A stray out-of-scope `src/register-commands.ts` was still present in the repo and broke `npm run build`; deleting it restored the intended Phase 0 source boundary and let the contract task verify cleanly.

## 2026-04-21T07:41:57Z Task: discord-bootstrap-contract-repair

- The actual source regression was a contract split-brain: `src/app.ts` and `src/utils/logger.ts` were already on the newer Phase 0 API, while `src/config.ts` and `src/types.ts` had reverted to an older `config` / `Env` / `ConfigError` shape.
- Restoring `loadConfig`, `AppConfig`, `LogLevel`, and `ConfigValidationError` in the source files fixed the compile errors without weakening the typed Discord requirements contract.
- After the repair, a fresh `npm run build` succeeded from current source and the rebuilt app still failed fast with a logged `ConfigValidationError` when the required Discord env vars were absent.

## 2026-04-21T07:49:30Z Task: phase-0-register-commands-bootstrap

- `src/register-commands.ts` now registers only the Phase 0 `join` and `leave` slash commands and reuses `loadConfig()` plus the typed Discord requirements contract instead of introducing a second command-registration config shape.
- The registration entrypoint treats `DISCORD_GUILD_ID` as a local preflight requirement for guild-scoped bootstrap work, so it aborts with `ConfigValidationError` before any Discord REST request when that value or the core required Discord env vars are missing.
- The bootstrap source tree was also brought back to the single `loadConfig` / `AppConfig` / `ConfigValidationError` contract so `npm run build` and `npm run register:commands` share the same Phase 0 configuration behavior.

## 2026-04-21T07:57:30Z Task: phase-1-storage-foundation

- Added `src/storage/db.ts` and `src/storage/threadSessionRepo.ts` only, keeping Phase 1 persistence scoped to the single `thread_sessions` table described in the plan.
- `initializeDatabase(databaseFilePath)` now creates parent directories when needed, applies basic SQLite pragmas, and creates `thread_sessions` on first run before returning the database handle.
- `createThreadSessionRepo(database)` exposes only `bind`, `findSessionId`, and `exists`; the runtime check verified missing lookups return `null`, bindings persist, and rebinding the same thread updates the stored session ID.

## 2026-04-21T08:11:01Z Task: phase-1-discord-output-rendering

- `src/discord/partRenderer.ts` now renders the normalized Phase 1 assistant output union from `src/opencode/parts.ts` one part at a time, with explicit visible labels for `text`, `reasoning`, `tool_call`, `tool_result`, `error`, and `unknown` so no assistant part kind is silently dropped.
- `src/discord/messageSplitter.ts` stays semantic-free and only handles Discord-safe chunking, prioritizing paragraph breaks, then newlines, then whitespace, then hard splits while reopening/closing fenced code blocks when a split lands inside one.
- `src/discord/replies.ts` now sends rendered assistant parts sequentially in thread order without merging distinct parts, and it emits a fallback Discord message when the assistant returns zero output parts.

## 2026-04-21T08:10:00Z Task: phase-1-opencode-integration-modules

- `src/opencode/sdk.ts` now centralizes `createOpencodeClient(...)` setup, normalizes the configured base URL, forwards the workspace directory through the SDK's built-in directory support, and only adds an `Authorization` header when an API key is configured.
- `src/opencode/sessions.ts` wraps the official SDK's `session.create(...)` and `session.prompt(...)` methods, keeps text prompts on the required `parts` contract, and returns both raw SDK parts and normalized internal assistant parts for later Discord rendering.
- `src/opencode/parts.ts` treats SDK `text`, `reasoning`, and `tool` parts explicitly, converts tool lifecycle states into internal `tool_call` / `tool_result` / `error` variants, and preserves all unsupported SDK part types as visible `unknown` outputs instead of dropping them.

## 2026-04-21T08:18:00Z Task: phase-0-app-bootstrap-repair

- Restored `src/app.ts` to the earlier Phase 0 shell only: it now loads config, sets logger level, builds the Discord client from `config.discord.requirements`, logs ready/warn/error lifecycle events, installs shutdown handlers, and logs in without wiring any message/session/thread pipeline behavior.
- The retained Phase 1 helper modules stayed in place untouched by the rollback, so the scope repair removed only the early integration point from `src/app.ts` instead of weakening the reusable Discord/OpenCode helper surface.

## 2026-04-21T08:21:19Z Task: phase-1-pipeline-scope-cleanup

- Deleted `src/pipeline/enqueue.ts`, `src/pipeline/handleAssistantParts.ts`, and `src/pipeline/handleThreadMessage.ts` entirely so the repo no longer carries the out-of-scope text-session pipeline slice before the later explicit pipeline tasks are started.
- Re-restored `src/app.ts` to a pure Phase 0 bootstrap entrypoint only; the retained OpenCode and Discord helper modules still build in the workspace, but the app entrypoint no longer imports or triggers any thread/session/pipeline logic.

## 2026-04-21T08:02:19Z Task: phase-1-discord-thread-helpers

- Added `src/discord/threadGuards.ts` as a pure validation layer: `isThreadMessage(message)` detects any thread message, while `assertManagedSessionThread(channelOrInteraction)` accepts either a channel or interaction context and only allows Discord public threads created from a parent message flow.
- Added `src/discord/sessionThreads.ts` with only the minimal managed-thread operations needed for later handlers: `createSessionThreadFromMessage(message, title)` wraps `message.startThread(...)`, and `replyInThread(thread, content)` wraps `thread.send(...)`.
- Centralized thread helper input normalization with trimmed non-empty string checks, and capped created thread titles at Discord's 100-character limit so later Phase 1+ handlers can stay focused on session/pipeline logic instead of duplicating Discord thread constraints.

## 2026-04-21T08:21:04Z Task: phase-1-discord-thread-helpers-finalize

- Narrowing the helper surface back to the MVP contract mattered: `sessionThreads.ts` now exposes only thread creation and reply sending, while `threadGuards.ts` exposes only thread-message detection plus strict managed-thread assertion, with app-specific bot/permission checks kept in `src/app.ts` instead of expanding the helper modules.
- `assertManagedSessionThread(...)` now accepts direct channels plus message/interaction-like `.channel` holders, but only succeeds for Discord public threads; this keeps the helper reusable by later handlers without weakening the Phase 1 "created from a message" thread constraint.
- `replyInThread(...)` now validates Discord's 2000-character message limit up front and preserves reply body whitespace, so later rendering/splitting layers can control formatting while this helper only enforces the API boundary.

## 2026-04-21T08:19:53Z Task: phase-1-serialized-text-pipeline

- Added `src/pipeline/enqueue.ts`, `src/pipeline/handleAssistantParts.ts`, and `src/pipeline/handleThreadMessage.ts`, then rewired `src/app.ts` so monitored-channel mentions and managed-thread follow-ups both run through the same serialized text-session path.
- A fresh `npm run build` now exits `0`, and a focused `tsx --eval` smoke check confirmed that two enqueued tasks for the same thread execute in strict order: `first:start`, `first:end`, `second:start`, `second:end`.

## 2026-04-21T08:33:59Z Task: phase-1-bot-event-wiring

- `src/app.ts` had all remaining Phase 1 bot behavior inline already, so the safest extraction was a literal move of the ready log payload and message-create helpers into dedicated `src/bot/*` modules instead of introducing new abstractions around the serialized pipeline.
- After the extraction, `npm run build` still exits `0`, and the focused queue smoke check still prints `first:start -> first:end -> second:start -> second:end`, confirming the bot wiring change did not disturb per-thread serialization.

## 2026-04-21T08:36:00Z Task: phase-1-serialized-pipeline-core

- `src/pipeline/enqueue.ts` now keeps an explicit per-thread queue state (`tail` + `size`) so serialization remains thread-local and queue cleanup happens as soon as the last task for that thread completes.
- `src/pipeline/handleAssistantParts.ts` now does the final dispatch guardrails itself: empty assistant outputs send the required fallback reply, non-empty outputs still flow through `src/discord/replies.ts`, and dispatch failures attempt a visible fallback error reply instead of silently disappearing.
- Verification succeeded with `npm run build` plus a built-runtime smoke check that reproduced ordered same-thread execution: `first:start`, `first:end`, `second:start`, `second:end`, with `hasPending('thread-1') === false` afterward.
- Finalized the dispatch-failure path so `handleAssistantParts(...)` now throws after successfully posting the fallback error reply; that preserves a visible Discord failure message while keeping dispatch failures distinguishable from a true empty-output `[]` result.

## 2026-04-21T08:41:05Z Task: phase-2-voice-runtime

- Added `src/voice/runtime.ts` with `createVoiceRuntimeRegistry()`, storing the Phase 2 minimum runtime shape (`guildId`, `threadId`, `sessionId`, `voiceChannelId`, `connection`, `isRecording`) using the official `@discordjs/voice` `VoiceConnection` type.
- The registry normalizes trimmed non-empty identifiers and returns `null` for missing lookups, matching the repo's existing small-helper style from `threadSessionRepo.ts` while reserving `RuntimeError` for invalid input or illegal recording-state updates.
- Verification passed with `npm run build` and a built-module smoke test covering empty lookups, same-guild replacement, recording-state updates, coexistence across two guilds, and removal cleanup for both guild and thread lookups.

## 2026-04-21T08:43:18Z Task: phase-2-voice-control-slice

- `src/voice/runtime.ts` now stores the live `guild`, managed `thread`, bound `session`, `voiceChannel`, `connection`, and `recording` state objects in a guild-keyed in-memory store, so later Phase 4 voice-to-session work can reuse runtime state directly instead of re-resolving IDs.
- `assertManagedSessionThread(...)` only proves the context is a public thread; `join`/`leave` still need a `threadSessionRepo.findSessionId(thread.id)` lookup to confirm the thread is actually one of the bot's managed session threads.
- A focused built-runtime smoke check passed against `dist/voice/runtime.js` and `dist/voice/joinLeave.js`, proving the guild runtime store's set/get/delete lifecycle and that the join/leave module exports load cleanly after `npm run build`.

## 2026-04-21T08:48:35Z Task: phase-2-voice-runtime-repair

- The verification failure came from contract drift: `src/voice/runtime.ts` had been replaced with a different store surface (`get`/`delete`/object-heavy state) than the intended runtime registry described by the task and previous summary.
- Repaired the module by restoring the practical registry API around guild/thread/session/channel ids plus `VoiceConnection` and `isRecording`, while preserving optional Discord object references and a compatibility `guildVoiceRuntimes` wrapper so the current `joinLeave.ts` continues to build.
- Verification passed with `npm run build` and a fresh built-module smoke test covering empty lookup, set, same-guild replacement, thread lookup, recording-state updates, two-guild coexistence, and removal cleanup.

## 2026-04-21T08:57:33Z Task: phase-2-command-surface

- Added dedicated Phase 2 slash-command modules at `src/bot/commands/join.ts` and `src/bot/commands/leave.ts`; each stays thin by adapting the Discord chat-input interaction into the existing `joinGuildVoiceRuntime(...)` / `leaveGuildVoiceRuntime(...)` calls.
- Added `src/bot/events/interactionCreate.ts` as the single slash-command boundary: it ignores non-chat interactions and unrelated command names, rejects non-guild usage with a concise reply, defers supported guild command handling, and returns only user-safe error messages.
- `src/bot/client.ts` now wires the new interaction handler with just `threadSessionRepo`, leaving `src/app.ts` unchanged because the existing `BotServices` shape already satisfied the needed typing.
- Verification passed with `npm run build` and a built-runtime smoke check against `dist/bot/events/interactionCreate.js` confirming `join`/`leave` dispatch plus ignore behavior for unrelated and non-chat interactions.

## 2026-04-21T08:56:00Z Task: phase-2-voice-slash-interactions

- `src/bot/commands/join.ts` and `src/bot/commands/leave.ts` stay intentionally thin: each checks `interaction.inGuild()`, validates public-thread context through `assertManagedSessionThread(...)`, and then delegates the real managed-session lookup plus voice-state/runtime enforcement to `src/voice/joinLeave.ts`.
- `src/bot/events/interactionCreate.ts` only handles chat-input interactions and only routes `join` / `leave`; it immediately `deferReply()`s recognized commands, then converts successful results and known `RuntimeError` failures into concise `editReply(...)` responses so slash-command ack timing stays safe.
- The focused built-module smoke check proved the new interaction wiring loads from `dist/`, ignores non-chat-input and non-`join`/`leave` commands, and routes rejected DM-style `join` / `leave` interactions to the expected server-only reply path after `npm run build`.

## 2026-04-21T09:14:35Z Task: phase-3-speaker-segmentation-core

- `src/voice/segmenter.ts` now owns the per-speaker utterance state explicitly as `{ userId, chunks, speaking, lastVoiceAt, startedAt }`, keeping the Phase 3 segmentation boundary independent from Discord receiver wiring and ASR/session integration.
- The segmenter API is intentionally receiver-driven: `markSpeakerActive`, `markSpeakerInactive`, `appendChunk`, `flushExpired`, `flushSpeaker`, and `flushAll` cover speaking events, chunk intake, periodic timeout scans, and manual teardown without duplicating flush logic in later modules.
- A built smoke check against `dist/voice/segmenter.js` proved both required flush paths on synthetic chunk input: silence timeout flush after inactivity and deterministic max-utterance flush once the configured utterance window is exceeded.

## 2026-04-21T09:12:00Z Task: phase-3-voice-capture-core

- `src/voice/receiver.ts` now stays Discord-specific and transport-focused: it resolves the active guild runtime from the shared registry, subscribes each speaker on `receiver.speaking.start` with `EndBehaviorType.Manual`, and toggles the runtime recording flag without mixing in transcript/session handling.
- `src/voice/segmenter.ts` now owns silence and max-duration segmentation with per-speaker timers, so Discord's heuristic speaking events are used only to start receive streams while utterance boundaries come from local buffer timing.
- `src/voice/normalizer.ts` now provides a deterministic PCM16 pipeline for later ASR work by mixing interleaved PCM to mono, resampling to fixed-rate 16 kHz audio, and writing a standard RIFF/WAV header around the normalized samples.

## 2026-04-21T09:12:22Z Task: phase-3-http-asr-layer

- Added `src/asr/client.ts` as a small provider-agnostic HTTP wrapper around `undici.fetch`, with per-request timeout bounds, bounded retries, `Retry-After` handling, and retry classification limited to network failures, local timeouts, and HTTP `408`/`429`/`5xx` responses.
- Added `src/asr/transcribe.ts` as the Phase 3 WAV boundary: it consumes normalized WAV bytes, builds multipart form data from the existing `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` config contract, normalizes common transcript response shapes into one local result union, and explicitly filters empty or too-short transcripts.
- A focused local in-process HTTP smoke test against the built `dist/asr/*` modules proved the retry policy and filtering behavior: success stayed at one attempt, `500` and `429` each retried once then succeeded, request timeouts exhausted two attempts and returned `ASR_TIMEOUT`, too-short transcripts returned `ASR_TRANSCRIPT_TOO_SHORT`, and `400` stayed non-retryable at one attempt.

## 2026-04-21T09:31:00Z Task: phase-3-segmenter-auto-flush-repair

- The root cause of the failed Phase 3 verification was that `src/voice/segmenter.ts` only exposed timeout checks through explicit `flushExpired()` polling and also gated silence flushing on `speaking === false`, so `pushChunk(...)` alone never scheduled a real runtime flush.
- Repairing the segmenter in place fixed the behavior without moving policy into Discord transport code: it now creates per-speaker silence and max-utterance timers on chunk intake, clears them on flush, and emits `onSegment` automatically from those timer callbacks.
- A fresh built-runtime smoke test now proves automatic emission after real timeouts with no external `flushExpired()` call, while the existing WAV normalizer smoke test remains green.

## 2026-04-21T09:35:45Z Task: phase-3-asr-slice

- `src/asr/client.ts` now stays transport-only: it builds the multipart WAV request from the existing `ASR_BASE_URL` / `ASR_API_KEY` / `ASR_MODEL` contract, sends one generic HTTP transcription request with `undici`, and returns raw parsed response data plus HTTP metadata without owning retry or transcript policy.
- `src/asr/transcribe.ts` is now the caller-facing ASR boundary: `transcribeWav(buffer, filename?)` centralizes timeout, retry, transcript extraction, whitespace normalization, empty/too-short transcript rejection, and one consistent `AsrTranscriptionError` shape for later voice-session integration.
- Verification passed with `npm run build` and a built-module smoke check that imported `dist/asr/client.js` and `dist/asr/transcribe.js`, instantiated a client with placeholder config only, and confirmed the expected exports without requiring live credentials or network calls.

## 2026-04-21T09:40:40Z Task: phase-1-opencode-sdk-esm-cjs-fix

- Switched `src/opencode/sdk.ts` to runtime-safe dynamic `import('@opencode-ai/sdk')` in an async factory path and updated `createOpencodeSdkContext` to async.
- Updated `src/app.ts` callsite to `await createOpencodeSdkContext(config)` so startup now progresses to config validation before any Discord connect or runtime failures.
- Verified fix by building then running `env -i PATH=... HOME=... node dist/app.js`, which now ends with `ConfigValidationError` (missing Discord env) instead of `ERR_PACKAGE_PATH_NOT_EXPORTED`.
