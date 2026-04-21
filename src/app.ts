import { Client, Events } from 'discord.js';

import { loadConfig } from './config';
import type { AppConfig } from './types';
import { toError } from './utils/errors';
import { createLogger, setLoggerLevel } from './utils/logger';
import { elapsedMilliseconds, now, toIsoTimestamp } from './utils/time';

const logger = createLogger({ module: 'app' });

export function createDiscordClient(config: AppConfig): Client {
  return new Client({
    intents: config.discord.requirements.gatewayIntents,
    partials: config.discord.requirements.partials,
  });
}

async function stop(client: Client, signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'Shutting down Discord client');
  client.destroy();
}

export async function start(): Promise<Client> {
  const startupStartedAt = now();
  const config = loadConfig();

  setLoggerLevel(config.logLevel);

  const client = createDiscordClient(config);

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      {
        userId: readyClient.user.id,
        userTag: readyClient.user.tag,
        applicationId: config.discord.clientId,
        monitoredChannelId: config.discord.monitoredChannelId,
        gatewayIntentNames: config.discord.requirements.gatewayIntentNames,
        partialNames: config.discord.requirements.partialNames,
        permissionFlagNames: config.discord.requirements.permissionFlagNames,
        startupStartedAt: toIsoTimestamp(startupStartedAt),
        startupDurationMs: elapsedMilliseconds(startupStartedAt),
      },
      'Discord client is ready',
    );
  });

  client.on(Events.Warn, (message) => {
    logger.warn({ message }, 'Discord client warning');
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, 'Discord client error');
  });

  process.once('SIGINT', () => {
    void stop(client, 'SIGINT');
  });

  process.once('SIGTERM', () => {
    void stop(client, 'SIGTERM');
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
