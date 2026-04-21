# Mouth-plus-plus — Discord OpenCode Voice Bot

Discord bot that bridges voice and text channels with OpenCode AI sessions. Mention the bot in a monitored channel to create a thread-bound OpenCode session, then use `/join` to add voice interaction.

## Quick Start

```bash
# Install dependencies (Bun required)
bun install

# Copy environment template
cp .env.example .env
# Edit .env with: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_MONITORED_CHANNEL_ID, DISCORD_GUILD_ID, OPENCODE_API_KEY

# Build TypeScript
bun run build

# Register slash commands (/join, /leave) with Discord
bun run register:commands

# Start in dev mode (watch)
bun run dev

# Production start
bun run start
```

## Commands

| Command                     | Description                     |
| --------------------------- | ------------------------------- |
| `bun run build`             | Compile TypeScript to `dist/`   |
| `bun run typecheck`         | Type check without emitting     |
| `bun run dev`               | Watch mode with hot reload      |
| `bun run start`             | Run compiled `dist/app.js`      |
| `bun run register:commands` | Register Discord slash commands |

## Architecture Overview

**Runtime**: Bun (>=1.3.12)  
**Entry Point**: `src/app.ts` → creates Discord client, initializes SQLite, registers event handlers  
**Build Output**: `dist/` (ES2022, NodeNext modules)

### Key Directories

```
src/
├── app.ts                    # Bootstrap: client, db, services, event handlers
├── config.ts                 # Environment validation (zod), Discord intents/permissions
├── types.ts                  # Shared TypeScript types
├── register-commands.ts      # CLI to register /join and /leave with Discord API
├── bot/
│   ├── client.ts             # Discord client factory, event handler wiring
│   ├── commands/             # /join, /leave slash command handlers
│   └── events/               # ready, messageCreate, interactionCreate handlers
├── discord/
│   ├── sessionThreads.ts     # Thread creation and session binding logic
│   ├── threadGuards.ts       # Validation: managed thread context checks
│   ├── partRenderer.ts       # Convert OpenCode SDK parts → Discord messages
│   ├── messageSplitter.ts    # Chunk messages to <2000 chars, preserve code fences
│   └── replies.ts            # Discord message sending utilities
├── opencode/
│   ├── sdk.ts                # OpenCode SDK context wrapper
│   ├── sessions.ts           # Session lifecycle management
│   ├── parts.ts              # Part type normalization (text, reasoning, tool, error, unknown)
│   └── events.ts             # SDK event handling
├── pipeline/
│   ├── enqueue.ts            # Per-thread task queue (serializes all work per thread)
│   ├── handleThreadMessage.ts# Process text messages through OpenCode session
│   ├── handleAssistantParts.ts # Render assistant output parts to Discord
│   └── handleVoiceSegment.ts # Process voice transcript through same session pipeline
├── voice/
│   ├── runtime.ts            # In-memory voice runtime registry (one per guild)
│   ├── joinLeave.ts          # /join, /leave command logic, validation
│   ├── receiver.ts           # Discord voice audio receiver
│   ├── segmenter.ts          # Speaker buffer tracking, utterance segmentation
│   ├── normalizer.ts         # Convert to mono fixed-rate WAV
│   └── transport.ts          # Voice connection abstraction
├── asr/
│   ├── client.ts             # ASR HTTP client
│   └── transcribe.ts         # Transcription with retry/timeout/empty handling
├── storage/
│   ├── db.ts                 # SQLite wrapper (bun:sqlite), WAL mode, thread_sessions table
│   └── threadSessionRepo.ts  # thread_id ↔ session_id persistence
└── utils/
    ├── logger.ts             # Pino logger, structured JSON logging
    ├── errors.ts             # Custom error types (RuntimeError, ConfigValidationError)
    └── time.ts               # Time utilities
```

## Critical Implementation Rules

These constraints are hard requirements. Violations break core functionality.

### OpenCode SDK Usage

- **Always** use the official `@opencode-ai/sdk` — never raw HTTP
- **Always** wrap input in `parts` — never send raw strings to `session.prompt()`
- **Always** process every assistant output part type: `text`, `reasoning`, `tool`, `error`, `unknown`
- **Never** ignore any part type — all must produce Discord-visible output

### Thread Safety

- All work for a single thread must be **serialized** through `pipeline/enqueue.ts` queue
- Voice transcripts and text messages for the same thread must never execute concurrently
- Queue errors must not crash the bot — log and continue

### Code Formatting

- **Always** run `bun run format` before completing any task that modifies source files
- **Never** submit unformatted code — Prettier is a hard requirement for this codebase
- Format the entire project with `bun run format:all` when requested

### Discord Message Constraints

- **Never** exceed 2000 characters per Discord message
- Use `discord/messageSplitter.ts` which: splits by paragraph → newline → whitespace → hard split
- **Preserve code fences** — never split inside triple backticks
- Send parts sequentially — **never merge** different assistant parts into one message

### Voice Runtime

- **One active voice runtime per guild** — enforced in `voice/runtime.ts` registry
- `/join` validates: managed thread context, user in voice channel, no existing runtime
- Voice receiver only starts after successful runtime creation

### Message Handling

- **Never** re-consume bot-authored messages — check `message.author.bot` early in handlers
- Main channel mentions create threads; thread messages reuse stored session

### Database

- SQLite file at `.data/thread-sessions.sqlite` (created automatically)
- Uses WAL mode (`PRAGMA journal_mode = WAL`)
- Single table: `thread_sessions(thread_id PRIMARY KEY, session_id)`

## Environment Variables

Required (bot fails fast if missing):

- `DISCORD_BOT_TOKEN` — Discord bot token
- `DISCORD_CLIENT_ID` — Discord application/client ID
- `DISCORD_MONITORED_CHANNEL_ID` — Main text channel to monitor for mentions
- `DISCORD_GUILD_ID` — Test guild ID for command registration

Required for AI features:

- `OPENCODE_API_KEY` — OpenCode API key

Optional:

- `OPENCODE_BASE_URL` — defaults to `https://api.opencode.ai`
- `ASR_API_KEY`, `ASR_BASE_URL`, `ASR_MODEL` — ASR provider config
- `LOG_LEVEL` — `fatal|error|warn|info|debug|trace|silent` (default: `info`)
- `NODE_ENV` — `development|test|production`

## OpenCode Configuration

This repo uses the `oh-my-openagent` plugin. Agent definitions are in `.opencode/oh-my-openagent.json`. Key agents:

- `hephaestus` — Primary implementation agent (GPT-5.4, edit+test permissions)
- `sisyphus` — Orchestrator (Kimi K2.5)
- `oracle` — Architecture/debugging consultant (GPT-5.4 high)
- `explore`, `librarian` — Background search agents

## Testing & Validation

```bash
# Type check
bun run typecheck

# Build verification
bun run build

# Manual test flow:
# 1. Mention bot in monitored channel → thread created, session started
# 2. Reply in thread → same session used
# 3. /join from thread → bot joins your voice channel
# 4. Speak → transcript sent to session, response in thread
# 5. /leave → bot disconnects
```

## Common Issues

**Build fails**: Ensure Bun >=1.3.12 (`bun --version`)  
**Commands not appearing**: Run `bun run register:commands` after changing command definitions  
**Voice not connecting**: Check bot has `Connect` and `Speak` permissions in voice channel  
**SQLite errors**: Ensure `.data/` directory is writable

## Dependencies of Note

- `@opencode-ai/sdk` — AI session management (MUST use for all OpenCode interactions)
- `discord.js` + `@discordjs/voice` — Discord bot and voice handling
- `bun:sqlite` — Native SQLite (no external dep)
- `pino` — Structured logging
- `zod` — Runtime config validation
- `opusscript` — Opus codec for voice (lightweight, no native deps)
