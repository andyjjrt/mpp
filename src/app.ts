import { join } from 'node:path';

import { Client, Events } from 'discord.js';

import { createDiscordClient, registerBotEventHandlers, type BotServices } from './bot/client';
import { loadConfig } from './config';
import { createOpencodeSdkContext } from './opencode/sdk';
import { createThreadTaskQueue } from './pipeline/enqueue';
import { initializeDatabase, type ThreadSessionDatabase } from './storage/db';
import { createThreadSessionRepo } from './storage/threadSessionRepo';
import { toError } from './utils/errors';
import { createLogger, setLoggerLevel } from './utils/logger';
import { now } from './utils/time';

const logger = createLogger({ module: 'app' });
const THREAD_SESSION_DATABASE_PATH = join(process.cwd(), '.data', 'thread-sessions.sqlite');

async function stop(client: Client, signal: NodeJS.Signals, database: ThreadSessionDatabase): Promise<void> {
  logger.info({ signal }, 'Shutting down Discord client');
  client.destroy();
  database.close();
}

export async function start(): Promise<Client> {
  const startupStartedAt = now();
  const config = loadConfig();

  setLoggerLevel(config.logLevel);

  const client = createDiscordClient(config);
  const database = initializeDatabase(THREAD_SESSION_DATABASE_PATH);
  const services: BotServices = {
    config,
    opencodeContext: await createOpencodeSdkContext(config),
    threadSessionRepo: createThreadSessionRepo(database),
    threadTaskQueue: createThreadTaskQueue(),
  };

  registerBotEventHandlers(client, {
    config,
    services,
    startupStartedAt,
    threadSessionDatabasePath: THREAD_SESSION_DATABASE_PATH,
  });

  client.on(Events.Warn, (message) => {
    logger.warn({ message }, 'Discord client warning');
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, 'Discord client error');
  });

  process.once('SIGINT', () => {
    void stop(client, 'SIGINT', database);
  });

  process.once('SIGTERM', () => {
    void stop(client, 'SIGTERM', database);
  });

  await client.login(config.discord.botToken);

  return client;
}

async function main(): Promise<void> {
  try {
    await start();
  } catch (error) {
    logger.fatal({ err: toError(error) }, 'Application failed to start');
    process.exitCode = 1;
  }
}

void main();
