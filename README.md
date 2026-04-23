# Mouth-plus-plus — Discord OpenCode Voice Bot

A Discord bot that bridges voice and text channels with OpenCode AI sessions. Mention the bot in a monitored channel to create a thread-bound OpenCode session, then use `/join` to add voice interaction capabilities.

## Features

- **Thread-based AI Sessions**: Mention the bot to create a dedicated thread with persistent OpenCode AI session
- **Voice Integration**: Join voice channels and interact via speech-to-text
- **Slash Commands**: `/join`, `/leave`, `/model`, `/agent` for complete control
- **Persistent Sessions**: SQLite-backed session storage survives bot restarts
- **ASR Support**: Automatic Speech Recognition for voice transcription

## Prerequisites

- Node.js >= 22.0.0
- [pnpm](https://pnpm.io/) >= 9.0.0
- Discord Bot Token
- OpenCode API Key
- (Optional) ASR Provider API credentials

## Quick Start

### 1. Clone and Install

```bash
# Clone the repository
git clone git@github.com:andyjjrt/mpp.git
cd mpp

# Install dependencies
pnpm install
```

### 2. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your credentials:
# - DISCORD_BOT_TOKEN
# - DISCORD_CLIENT_ID
# - DISCORD_MONITORED_CHANNEL_ID
# - DISCORD_GUILD_ID
# - OPENCODE_API_KEY
```

### 3. Register Slash Commands

```bash
pnpm register:commands
```

### 4. Build and Run

```bash
# Build TypeScript
pnpm build

# Start in development mode (with hot reload)
pnpm dev

# Or start in production mode
pnpm start

# Or start in production mode
```

## Available Commands

| Command  | Description                          |
| -------- | ------------------------------------ |
| `/join`  | Bot joins your current voice channel |
| `/leave` | Bot leaves the voice channel         |
| `/model` | Change the AI model for this session |
| `/agent` | Change the AI agent for this session |

## Usage Flow

1. **Text Interaction**: Mention the bot in the monitored channel → a thread is created with a new OpenCode session
2. **Voice Interaction**: Use `/join` in the thread while in a voice channel → bot joins and listens
3. **Speak**: Talk naturally → your speech is transcribed and sent to the AI
4. **Responses**: AI responses appear in the thread
5. **Leave**: Use `/leave` or disconnect to end voice session

## Project Structure

```
src/
├── app.ts                    # Application bootstrap
├── config.ts                 # Environment validation
├── types.ts                  # Shared TypeScript types
├── register-commands.ts      # Slash command registration
├── bot/
│   ├── client.ts             # Discord client setup
│   ├── commands/             # Slash command handlers
│   └── events/               # Discord event handlers
├── discord/                  # Discord integration utilities
├── opencode/                 # OpenCode SDK integration
├── pipeline/                 # Message processing pipeline
├── voice/                    # Voice processing modules
├── asr/                      # ASR (speech-to-text) client
├── storage/                  # SQLite persistence
└── utils/                    # Logging, errors, utilities
```

## Scripts

| Script                   | Description                       |
| ------------------------ | --------------------------------- |
| `pnpm build`             | Compile TypeScript to `dist/`     |
| `pnpm typecheck`         | Type check without emitting       |
| `pnpm dev`               | Watch mode with hot reload        |
| `pnpm start`             | Run compiled application          |
| `pnpm register:commands` | Register Discord slash commands   |
| `pnpm format`            | Format staged files with Prettier |
| `pnpm format:all`        | Format all files with Prettier    |
| `pnpm test`              | Run tests                         |

## Environment Variables

### Required

| Variable                       | Description                            |
| ------------------------------ | -------------------------------------- |
| `DISCORD_BOT_TOKEN`            | Discord bot token                      |
| `DISCORD_CLIENT_ID`            | Discord application/client ID          |
| `DISCORD_MONITORED_CHANNEL_ID` | Channel to monitor for mentions        |
| `DISCORD_GUILD_ID`             | Test guild ID for command registration |
| `OPENCODE_API_KEY`             | OpenCode API key                       |

### Optional

| Variable             | Default                   | Description                                                                                                   |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_BASE_URL`  | `https://api.opencode.ai` | OpenCode API base URL                                                                                         |
| `OPENCODE_DIRECTORY` | -                         | Override the workspace directory sent to OpenCode; if unset, the API server chooses its own default directory |
| `ASR_API_KEY`        | -                         | ASR provider API key                                                                                          |
| `ASR_BASE_URL`       | -                         | ASR provider base URL                                                                                         |
| `ASR_MODEL`          | -                         | ASR model name                                                                                                |
| `LOG_LEVEL`          | `info`                    | Logging level                                                                                                 |
| `NODE_ENV`           | `development`             | Environment mode                                                                                              |

## Architecture Highlights

- **Thread Safety**: All work per thread is serialized through a task queue
- **Voice Runtime**: One active voice runtime per guild
- **Message Splitting**: Intelligent message chunking to respect Discord's 2000 character limit
- **Part Processing**: Handles all OpenCode SDK output types (text, reasoning, tool, error)
- **WAL Mode**: SQLite uses Write-Ahead Logging for better concurrency

## Development

### Prerequisites for Development

- Node.js 22 or higher
- pnpm 9 or higher
- Node.js-compatible environment
- Discord bot with appropriate permissions:
  - Send Messages
  - Create Public Threads
  - Send Messages in Threads
  - Connect (voice)
  - Speak (voice)

### Bot Permissions Required

In the Discord Developer Portal, enable these intents:

- Server Members Intent
- Message Content Intent

OAuth2 URL Generator scopes:

- `bot`
- `applications.commands`

Bot permissions:

- View Channels
- Send Messages
- Create Public Threads
- Send Messages in Threads
- Read Message History
- Use Slash Commands
- Connect
- Speak

## Troubleshooting

### Build fails

Ensure Node.js >= 22 and pnpm are installed: `node -v` and `pnpm -v`

### Commands not appearing

Run `pnpm register:commands` after adding new commands

### Voice not connecting

Check bot has `Connect` and `Speak` permissions in the voice channel

### SQLite errors

Ensure `.data/` directory is writable

## License

UNLICENSED

## Dependencies

- `@opencode-ai/sdk` — AI session management
- `discord.js` + `@discordjs/voice` — Discord bot and voice handling
- `better-sqlite3` — SQLite3 library for Node.js
- `pino` — Structured logging
- `zod` — Runtime config validation
- `opusscript` — Opus codec for voice
