# Decisions

## 2026-04-21T06:59:30Z Task: research-synthesis

- Treat phases 0-4 as the top-level implementation tasks for orchestration because the plan is phase-structured rather than checkbox-structured.
- Register deliverable-level task records under those phases before the first coding delegation.
- Keep implementation phase-scoped and sequential across phases unless an internal subtask is truly independent.

## 2026-04-21T07:08:21Z Task: package-manifest-bootstrap

- Use npm for the greenfield bootstrap and commit a generated `package-lock.json` so dependency resolution is reproducible from the first package manifest.
- Pin `@discordjs/voice` to `0.18.0` instead of the latest release because current `0.19.x` requires Node `>=22.12.0`, while this repo bootstrap is being validated on Node 20.
- Set `engines.node` to `>=20.0.0` because `better-sqlite3@12.9.0` is the strictest runtime dependency in the selected stack.
- Use generic HTTP client package `undici` rather than a vendor-specific ASR SDK so Phase 3 can implement ASR without forcing a provider commitment during the package-only bootstrap task.

## 2026-04-21T07:17:23Z Task: config-bootstrap-files

- Leave `package.json` unchanged for this task because its existing scripts already point at `tsconfig.json`, and the current build failure has progressed to source-level type errors rather than a config-path mismatch.
- Keep `.env.example` broader than the current source validation by documenting the planned monitored-channel contract and future ASR placeholders now, while preserving `DISCORD_GUILD_ID` because the repo's current bootstrap code already expects it.

## 2026-04-21T07:20:42Z Task: repair-config-bootstrap-scope

- Preserve the previously verified package bootstrap shape and only revert the dependency drift that was introduced for forbidden source files; specifically, remove `pino-pretty` but keep the original runtime/tooling set and script names unchanged.
- Keep `tsconfig.json` conventional with `src/**/*` inputs rather than weakening it to hide an empty-tree state; the empty-input compiler error is a more honest config-only stopping point until real source files are added in the next scoped task.

## 2026-04-21T07:28:00Z Task: phase-0-source-bootstrap

- Treat `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_MONITORED_CHANNEL_ID` as the required Phase 0 runtime contract because they are needed for the minimal Discord skeleton now; keep `DISCORD_GUILD_ID`, OpenCode, and ASR settings parsed but optional until later scoped tasks actually consume them.
- Keep the logger dependency-free beyond the already approved `pino` package and make startup failure observable by catching config errors in `src/app.ts` before any Discord client login attempt.

## 2026-04-21T07:31:30Z Task: phase-0-source-bootstrap-repair

- Repair the bootstrap in place by aligning `src/app.ts` to the real exports of the scoped modules rather than expanding `src/config.ts` or `src/utils/logger.ts` with backward-compatibility aliases from the rejected out-of-scope attempt.

## 2026-04-21T07:38:22Z Task: discord-bootstrap-contract

- Keep the Phase 0 Discord contract split into required identifiers (`botToken`, `clientId`, `monitoredChannelId`) plus a typed `requirements` block so later phases can reuse the same intents, partials, and permission flags without rediscovering them in `src/app.ts`.
- Model the feature needs by capability (`mentions`, `threads`, `slashCommands`, `voice`) and derive the union of required gateway intents and permission flags from that map, keeping the contract readable while still exposing concrete discord.js enum values for runtime use.

## 2026-04-21T07:41:57Z Task: discord-bootstrap-contract-repair

- Repair this regression by restoring a single consistent bootstrap API surface instead of adding backward-compatibility aliases: `src/app.ts` and `src/utils/logger.ts` stay on the newer `loadConfig` / `AppConfig` / `LogLevel` contract, and `src/config.ts` plus `src/types.ts` are brought back into alignment with that contract.
- Keep the Discord requirements contract narrow and explicit by typing only the currently needed intent, partial, and permission names, which avoids enum-shape ambiguity while preserving the reusable Phase 0 data for later text/thread/slash/voice work.

## 2026-04-21T07:49:30Z Task: phase-0-register-commands-bootstrap

- Register commands with `Routes.applicationGuildCommands` and require `config.discord.guildId` at the script boundary, because Phase 0 only needs a safe, explicit guild-scoped bootstrap target and should not create global-command propagation delay or a parallel registration contract.
- Keep the registration payload explicit to `join` and `leave` only, and log the existing slash-command capability intent/permission names from `config.discord.requirements` so later phases can see the shared Discord bootstrap contract in both startup and registration paths.

## 2026-04-21T07:57:30Z Task: phase-1-storage-foundation

- Keep database path selection outside Phase 1 config/bootstrap scope by making `initializeDatabase` accept an explicit file path instead of expanding `src/config.ts` with new env parsing before the later pipeline modules are ready to consume it.
- Use a small repository factory over the raw SQLite handle so later thread/session flow can depend on the narrow `bind` / `findSessionId` / `exists` contract without introducing broader persistence abstractions or extra tables.

# Decisions

## 2026-04-21T08:10:00Z Task: phase-1-opencode-integration-modules

- Kept `src/opencode/events.ts` intentionally small: only shared event aliases, a few type guards, and one subscription helper were added because the Phase 1 plan explicitly allows deferring fuller streaming infrastructure until later phases.
- Normalized assistant message-level SDK errors into the same internal assistant part union as message parts so later Discord rendering can stay part-driven and still surface failures without special out-of-band handling.

## 2026-04-21T08:11:01Z Task: phase-1-discord-output-rendering

- Replaced the earlier bulk-string renderer path with a part-at-a-time Discord rendering contract so Phase 1 can preserve assistant part boundaries now and later text/voice pipelines can reuse the same rendering and splitting modules without reintroducing part merging.
- Kept `messageSplitter.ts` strictly focused on mechanical chunking and put all labels/fallbacks/tool formatting in `partRenderer.ts`, because later pipelines will need the same split logic for already-rendered content while keeping assistant semantics centralized in one place.

## 2026-04-21T08:19:53Z Task: phase-1-serialized-text-pipeline

- Kept the Phase 1 pipeline split minimal: `enqueue.ts` owns only per-thread serialization, `handleThreadMessage.ts` owns session reuse/creation plus OpenCode prompting, and `handleAssistantParts.ts` remains a thin bridge to the existing Discord reply helpers so Phase 4 can reuse the same queue without rewriting text-session behavior.
- Put thread/session resolution inside `handleThreadMessage.ts` instead of `src/app.ts` so monitored-channel mentions and later managed-thread follow-ups both funnel through one prompt path, reducing the risk of session creation drift between entrypoints.

## 2026-04-21T08:18:00Z Task: phase-0-app-bootstrap-repair

- Repaired the scope creep by rolling back only `src/app.ts` rather than undoing the newly added helper modules, because the helpers themselves are valid reusable Phase 1 building blocks while the app entrypoint must stay a bootstrap shell until the explicit event/pipeline tasks are executed.

## 2026-04-21T08:21:19Z Task: phase-1-pipeline-scope-cleanup

- Removed the pipeline files instead of merely orphaning them, because leaving out-of-scope pipeline code in `src/` keeps the repo misleadingly ahead of the intended delivery order and risks later accidental imports back into the bootstrap entrypoint.

## 2026-04-21T08:33:59Z Task: phase-1-bot-event-wiring

- Extracted the working Discord runtime flow almost verbatim out of `src/app.ts` into `src/bot/events/ready.ts` and `src/bot/events/messageCreate.ts`, while keeping `src/app.ts` as the startup/composition root so Phase 1 behavior stays unchanged and later event additions can land without re-growing the entrypoint.
- Added `src/bot/client.ts` as the narrow composition seam for Discord client creation plus event registration, so `src/app.ts` now wires bot behavior through one module without duplicating startup or pipeline contracts.

## 2026-04-21T08:36:00Z Task: phase-1-serialized-pipeline-core

- Kept `enqueue.ts` limited to queue bookkeeping only by modeling a per-thread queue state instead of adding cross-thread orchestration or Discord/OpenCode knowledge; later text and voice entrypoints can reuse the same serializer without changing its contract.
- Kept `handleAssistantParts.ts` as the final output gate rather than expanding `src/discord/replies.ts`, so the reusable Discord reply helpers continue to own rendering/sending mechanics while the pipeline layer owns the empty-output and dispatch-failure policy required by this phase.

## 2026-04-21T08:41:05Z Task: phase-2-voice-runtime

- Implement `src/voice/runtime.ts` as a small in-memory registry factory keyed by `guildId`, because the Phase 2 contract is explicitly "one active voice runtime per guild" and later `joinLeave.ts` only needs lookup/update/remove operations rather than a broader service abstraction.
- Keep a secondary `threadId -> guildId` index inside the same registry so future voice handlers can resolve a runtime from the managed session thread without weakening the guild-keyed source of truth.

## 2026-04-21T08:43:18Z Task: phase-2-voice-control-slice

- Keep the Phase 2 runtime registry keyed only by `guildId`, because the MVP rule is one active voice runtime per guild and the later handler can enforce thread ownership by comparing `runtime.thread.id` instead of maintaining a second index now.
- Make `leave` thread-owned: a managed session thread may only disconnect the guild runtime it created, which prevents one session thread from silently tearing down another thread's active guild voice session while still honoring the single-runtime-per-guild rule.

## 2026-04-21T08:48:35Z Task: phase-2-voice-runtime-repair

- Restore `src/voice/runtime.ts` to an id-first registry contract (`getByGuildId`, `getByThreadId`, `set`, `removeByGuildId`, `updateRecordingState`) because later Phase 2/4 logic needs direct guild/thread resolution and mutation helpers rather than forcing callers through `entries()` scans.
- Keep a small compatibility wrapper export (`guildVoiceRuntimes`) inside `runtime.ts` so the already-present `joinLeave.ts` slice still compiles against object-rich runtime access without changing command logic during this repair.

## 2026-04-21T08:56:00Z Task: phase-2-voice-slash-interactions

- Keep slash-command routing narrow by adding one dedicated `interactionCreate` event module plus a literal `join` / `leave` dispatch table instead of introducing a generic command framework, because Phase 2 only needs these two commands and the task explicitly forbids overbuilding.
- Centralize slash-command reply/error plumbing in `src/bot/events/interactionCreate.ts`, while leaving `src/bot/commands/{join,leave}.ts` responsible only for guild/thread validation and delegation to `src/voice/joinLeave.ts`; that preserves the already-verified voice-control logic as the single source of truth for managed-session, duplicate-runtime, and active-session checks.

## 2026-04-21T09:12:00Z Task: phase-3-voice-capture-core

- Keep Phase 3 split exactly on transport boundaries: `receiver.ts` manages Discord voice subscriptions and runtime recording state, `segmenter.ts` owns speaker buffering plus silence/max-utterance flush policy, and `normalizer.ts` stays pure PCM-to-WAV logic for later reuse.
- Emit receiver segment callbacks with guild/thread/session/channel metadata attached to the segmenter payload, but stop short of transcript or session queue integration so Phase 3 does not leak into Phase 4.
- Normalize to mono 16 kHz PCM16 LE WAV as the default fixed-rate output because it is deterministic, ASR-friendly, and can be produced without adding new dependencies.

## 2026-04-21T09:12:22Z Task: phase-3-http-asr-layer

- Keep Phase 3 ASR split across exactly two modules: `src/asr/client.ts` owns generic HTTP execution concerns (timeout, retry, transient/error classification), while `src/asr/transcribe.ts` owns the WAV-specific multipart request shape plus transcript normalization/filtering so later queue/session wiring can consume a stable result union without inheriting transport details.
- Treat empty and too-short transcripts as explicit non-retryable result states (`ASR_EMPTY_TRANSCRIPT`, `ASR_TRANSCRIPT_TOO_SHORT`) instead of silently returning blank text, because Phase 4 will need a predictable contract for deciding whether to ignore, surface, or recover from low-signal speech results.

## 2026-04-21T09:14:35Z Task: phase-3-speaker-segmentation-core

- Keep `src/voice/segmenter.ts` self-contained and id-first like the existing voice runtime registry: validate inputs up front, own the speaker state map internally, and emit stable segment payloads (`userId`, concatenated audio buffer, timing metadata, flush reason) so later receiver/normalizer layers can compose around it instead of re-implementing buffer policy.
- Preserve build compatibility by adapting the segmenter surface to the receiver that is already present in the tree, rather than modifying `src/voice/receiver.ts`; that keeps this task focused on segmentation logic while still restoring a green repository state.

## 2026-04-21T09:31:00Z Task: phase-3-segmenter-auto-flush-repair

- Keep the repair entirely inside `src/voice/segmenter.ts` so the timing policy remains authoritative there; `src/voice/receiver.ts` should continue to act only as the Discord receive transport adapter unless a future API break makes a minimal alignment unavoidable.
- Preserve the current public segmenter surface (`appendChunk`, `pushChunk`, `flushExpired`, `destroy`, optional `onSegment`) while adding internal timer ownership, so the runtime behavior is fixed without forcing broader Phase 3/4 rewiring.

## 2026-04-21T09:35:45Z Task: phase-3-asr-slice

- Keep the ASR split strict for this phase: `src/asr/client.ts` owns only generic WAV HTTP request construction and response parsing, while `src/asr/transcribe.ts` owns retry, timeout, transcript filtering, and unified error wrapping so later Phase 4 pipeline code can call one stable function without inheriting transport policy.
- Preserve workspace build compatibility by re-exporting a thin `transcribeNormalizedWav(...)` adapter from `src/asr/transcribe.ts` instead of modifying the already-present `src/pipeline/handleVoiceSegment.ts`; this keeps the task scoped to the ASR boundary while still delivering a green build.

## 2026-04-21T09:40:40Z Task: phase-1-opencode-sdk-esm-cjs-fix

- Kept fix narrowly scoped to SDK loading path: avoid package-level module-system changes and only made the SDK context factory async for ESM/CJS interop safety.
- Preserved existing OpenCode surface contracts (`createOpencodeSdkConfig` and `OpencodeSdkContext`) and limited callsite edits to startup composition point in `src/app.ts`.
