# Minimal MVP Plan — Discord × OpenCode × Voice

## Context

- Repository state: greenfield; no source files exist yet.
- Implementation target: TypeScript Node bot with Discord text + voice flow.
- Non-negotiables from spec:
  - OpenCode only through the official SDK
  - Session input always sent as `parts`
  - Assistant output always processed by message part
  - Every output part must produce Discord-visible output
  - Outgoing Discord messages must stay under 2000 characters
  - Inputs for one thread must be serialized
  - Only one active voice runtime per guild
  - Bot-authored messages must never be re-consumed

## Scope Boundaries

- MVP only. No extra commands beyond `join` and `leave`.
- One managed session thread maps to one OpenCode session.
- One active voice runtime per guild.
- Final assistant output may be sent after prompt completion; streaming can be deferred unless the SDK shape makes it necessary.
- Keep persistence limited to `thread_sessions`.

## Phase 0 — Bootstrap

### Outcome

The repo can build and run a minimal TypeScript Discord bot skeleton.

### Deliver

- [x] Initialize Node + TypeScript project structure matching the spec.
- [x] Add runtime dependencies for Discord, voice, SQLite, logging, env/config validation, HTTP/ASR, and the official OpenCode SDK.
- [x] Add `tsconfig`, scripts, `.env.example`, and app bootstrap files.
  - [x] Add `tsconfig.json` and `.env.example` bootstrap config files.
- [x] Create `src/app.ts`, `src/config.ts`, `src/types.ts`, and `src/utils/{logger,errors,time}.ts`.
- [x] Define the Discord bootstrap contract: bot token, application/client ID, monitored channel ID, and the intents/permissions needed for mentions, threads, slash commands, and voice.
- [x] Add slash-command registration for `join` and `leave` as part of bootstrap so Phase 2 has real commands to exercise.

### Done When

- `npm run build` exits 0.
- Config loading fails fast on missing required env.
- Logger is usable across modules.

### QA

- Run build.
- Start the app with placeholder env and verify config validation behavior.

## Phase 1 — Text Session Flow

### Outcome

A main-channel mention creates an OpenCode session, creates a Discord thread, binds the thread to the session, and continues the same session for later thread messages.

### Deliver

- [x] `storage/db.ts` and `storage/threadSessionRepo.ts` with `bind`, `findSessionId`, and `exists`.
- [x] `opencode/sdk.ts`, `opencode/sessions.ts`, `opencode/parts.ts`, and `opencode/events.ts`.
- [x] `discord/sessionThreads.ts`, `discord/threadGuards.ts`, `discord/partRenderer.ts`, `discord/messageSplitter.ts`, and `discord/replies.ts`.
- [x] `pipeline/enqueue.ts`, `pipeline/handleThreadMessage.ts`, and `pipeline/handleAssistantParts.ts`.
- [x] `bot/client.ts`, `bot/events/{ready,messageCreate}.ts`.

### Implementation Notes

- `storage/db.ts` owns first-run SQLite initialization, including `thread_sessions` table creation.
- Use SDK `session.create(...)` and `session.prompt(...)` only.
- Wrap all user text input as SDK text parts.
- Normalize every assistant output part into the internal union, including `unknown`.
- Split outgoing messages by paragraph, newline, whitespace, then hard split, while preserving code fences.
- Send part output sequentially and never merge different assistant parts.
- Ignore all bot-authored messages.

### Done When

- Mentioning the bot in the monitored channel creates a thread and persists `thread_id -> session_id`.
- The original mention is forwarded as the first session prompt.
- Later messages inside that thread reuse the stored session.
- Empty assistant parts trigger a fallback message.
- Text, reasoning, tool, error, and unknown parts all produce Discord output.

### QA

- Manual test: mention bot in monitored channel and confirm thread creation.
- Manual test: send a follow-up thread message and confirm the same session is used.
- Manual test: force a long output and confirm every chunk is below 2000 chars.

## Phase 2 — Voice Control

### Outcome

`join` and `leave` work only inside managed session threads and enforce one active voice runtime per guild.

### Deliver

- [x] `voice/runtime.ts` runtime map with guild, thread, session, voice-channel, connection, and recording state.
- [x] `voice/joinLeave.ts`.
- [x] `bot/commands/{join,leave}.ts` and `bot/events/interactionCreate.ts`.

### Implementation Notes

- `join` validates managed thread context, user voice presence, and no active runtime in guild.
- `leave` resolves current runtime, disconnects, and clears state.
- Return concise user-facing errors for invalid contexts and duplicate joins.

### Done When

- `join` connects from a valid session thread.
- Second `join` in the same guild is rejected.
- `leave` disconnects and clears runtime state.

### QA

- Manual test: `join` in invalid channel fails.
- Manual test: `join` in valid thread succeeds.
- Manual test: second `join` in same guild fails.
- Manual test: `leave` succeeds and allows a later re-join.

## Phase 3 — Voice Segmentation + ASR

### Outcome

Voice input is captured per speaker, segmented into utterances, normalized to WAV, and transcribed with retries/timeouts.

### Deliver

- `voice/receiver.ts`, `voice/segmenter.ts`, `voice/normalizer.ts`.
- `asr/client.ts`, `asr/transcribe.ts`.

### Implementation Notes

- Receiver only handles Discord voice audio and forwards chunks to the segmenter.
- Segmenter tracks speaker buffers and flushes on silence timeout or max utterance duration.
- Normalizer emits mono fixed-rate WAV buffers.
- ASR layer handles timeout, retry, empty transcript, and unified error wrapping.

### Done When

- Speaking creates stable WAV segments.
- Empty or too-short transcripts are dropped.
- ASR failures are surfaced to logs and handled without crashing the bot.

### QA

- Manual test: speak one short utterance and verify one WAV segment is produced.
- Manual test: verify silence timeout flush.
- Manual test: verify max utterance force flush.

## Phase 4 — Voice to Session Integration

### Outcome

Voice transcript enters the same OpenCode session bound to the thread, and assistant part output returns to that same thread.

### Deliver

- `pipeline/handleVoiceSegment.ts`.
- Receiver-to-pipeline wiring via `pipeline/enqueue.ts`.

### Implementation Notes

- Resolve thread/session from the guild runtime.
- Format transcript as `<display_name>: <transcript>`.
- Reuse the same session prompt + part handling pipeline as text input.
- Serialize voice and text work per thread through the same queue.
- Optionally post transcript to thread if config enables it.

### Done When

- Voice transcript reuses the same session created from the thread.
- Assistant response appears in the same thread.
- Voice and text inputs for one thread never execute concurrently.

### QA

- Manual test: create session from mention, then `join`, then speak.
- Confirm transcript is sent to OpenCode and response lands in the same thread.
- Confirm rapid text + speech inputs still execute in order.

## Cross-Cutting Acceptance Checks

- No module bypasses the official OpenCode SDK.
- No prompt call sends raw string input without wrapping it in `parts`.
- No assistant part type is silently ignored.
- No Discord message chunk exceeds 2000 characters.
- No same-thread session prompt runs concurrently.
- No bot-authored Discord message is re-consumed.

## Suggested Delivery Order

1. Bootstrap
2. Text session flow
3. Voice control
4. Voice segmentation + ASR
5. Voice-to-session integration
6. End-to-end validation

## First Commit Boundary Recommendation

Keep implementation commits phase-scoped:

1. bootstrap project skeleton
2. add text session pipeline
3. add thread part rendering and splitting
4. add voice join/leave runtime
5. add voice segmentation and ASR
6. connect voice transcripts to session pipeline
