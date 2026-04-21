import { Events, type Client } from 'discord.js';

import type { AppConfig } from '../../types.js';
import { createLogger } from '../../utils/logger.js';
import { elapsedMilliseconds, toIsoTimestamp } from '../../utils/time.js';

const logger = createLogger({ module: 'app' });

export interface RegisterReadyHandlerOptions {
  config: AppConfig;
  startupStartedAt: Date;
  threadSessionDatabasePath: string;
}

export function registerReadyHandler(client: Client, options: RegisterReadyHandlerOptions): void {
  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      {
        userId: readyClient.user.id,
        userTag: readyClient.user.tag,
        applicationId: options.config.discord.clientId,
        monitoredChannelId: options.config.discord.monitoredChannelId,
        gatewayIntentNames: options.config.discord.requirements.gatewayIntentNames,
        partialNames: options.config.discord.requirements.partialNames,
        permissionFlagNames: options.config.discord.requirements.permissionFlagNames,
        threadSessionDatabasePath: options.threadSessionDatabasePath,
        startupStartedAt: toIsoTimestamp(options.startupStartedAt),
        startupDurationMs: elapsedMilliseconds(options.startupStartedAt),
      },
      'Discord client is ready'
    );
  });
}
