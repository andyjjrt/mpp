import { Client } from 'discord.js';

import type { AppConfig } from '../types.js';
import type { OpencodeSdkContext } from '../opencode/sdk.js';
import type { ThreadTaskQueue } from '../pipeline/enqueue.js';
import type { ThreadSessionRepo } from '../storage/threadSessionRepo.js';
import {
  registerInteractionCreateHandler,
  type RegisterInteractionCreateHandlerOptions,
} from './events/interactionCreate.js';
import {
  registerMessageCreateHandler,
  type RegisterMessageCreateHandlerOptions,
} from './events/messageCreate.js';
import { registerReadyHandler, type RegisterReadyHandlerOptions } from './events/ready.js';

export interface RegisterBotEventHandlersOptions {
  config: AppConfig;
  services: RegisterMessageCreateHandlerOptions['services'];
  startupStartedAt: RegisterReadyHandlerOptions['startupStartedAt'];
  threadSessionDatabasePath: RegisterReadyHandlerOptions['threadSessionDatabasePath'];
}

export interface BotServices {
  opencodeContext: OpencodeSdkContext;
  threadSessionRepo: ThreadSessionRepo;
  threadTaskQueue: ThreadTaskQueue;
}

type InteractionCreateServices = RegisterInteractionCreateHandlerOptions['services'];

function resolveInteractionCreateServices(services: BotServices): InteractionCreateServices {
  return {
    threadSessionRepo: services.threadSessionRepo,
  };
}

export function createDiscordClient(config: AppConfig): Client {
  return new Client({
    intents: config.discord.requirements.gatewayIntents,
    partials: config.discord.requirements.partials,
  });
}

export function registerBotEventHandlers(client: Client, options: RegisterBotEventHandlersOptions): void {
  registerInteractionCreateHandler(client, {
    services: resolveInteractionCreateServices(options.services),
  });
  registerMessageCreateHandler(client, {
    config: options.config,
    services: options.services,
  });
  registerReadyHandler(client, {
    config: options.config,
    startupStartedAt: options.startupStartedAt,
    threadSessionDatabasePath: options.threadSessionDatabasePath,
  });
}
