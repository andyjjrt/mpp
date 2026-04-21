import {
  EmbedBuilder,
  Events,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js';

import type { AppConfig } from '../../types.js';
import type { OpencodeSdkContext } from '../../opencode/sdk.js';
import type { ThreadTaskQueue } from '../../pipeline/enqueue.js';
import type { ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import { RuntimeError, toError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import { handleAgentAutocomplete, handleAgentCommand } from '../commands/agent.js';
import { handleJoinCommand } from '../commands/join.js';
import { handleLeaveCommand } from '../commands/leave.js';
import { handleModelAutocomplete, handleModelCommand } from '../commands/model.js';

const logger = createLogger({ module: 'app' });

interface InteractionCreateServices {
  threadSessionRepo: ThreadSessionRepo;
  threadTaskQueue: ThreadTaskQueue;
  opencodeContext: OpencodeSdkContext;
  config: AppConfig;
}

export interface InteractionCommandResult {
  message?: string;
  embeds?: EmbedBuilder[];
}

export interface RegisterInteractionCreateHandlerOptions {
  services: InteractionCreateServices;
  commandHandlers?: InteractionCommandHandlers;
  autocompleteHandlers?: InteractionAutocompleteHandlers;
}

export type InteractionCommandHandler = (
  services: InteractionCreateServices,
  interaction: ChatInputCommandInteraction
) => Promise<InteractionCommandResult>;

export type InteractionAutocompleteHandler = (
  services: InteractionCreateServices,
  interaction: AutocompleteInteraction
) => Promise<void>;

export interface InteractionCommandHandlers {
  agent: InteractionCommandHandler;
  join: InteractionCommandHandler;
  leave: InteractionCommandHandler;
  model: InteractionCommandHandler;
}

export interface InteractionAutocompleteHandlers {
  agent: InteractionAutocompleteHandler;
  model: InteractionAutocompleteHandler;
}

const defaultInteractionCommandHandlers: InteractionCommandHandlers = {
  agent: handleAgentCommand,
  join: handleJoinCommand,
  leave: handleLeaveCommand,
  model: handleModelCommand,
};

const defaultInteractionAutocompleteHandlers: InteractionAutocompleteHandlers = {
  agent: handleAgentAutocomplete,
  model: handleModelAutocomplete,
};

function resolveInteractionCommandHandler(
  commandName: string,
  commandHandlers: InteractionCommandHandlers
): InteractionCommandHandler | null {
  switch (commandName) {
    case 'agent':
      return commandHandlers.agent;
    case 'join':
      return commandHandlers.join;
    case 'leave':
      return commandHandlers.leave;
    case 'model':
      return commandHandlers.model;
    default:
      return null;
  }
}

function resolveInteractionAutocompleteHandler(
  commandName: string,
  autocompleteHandlers: InteractionAutocompleteHandlers
): InteractionAutocompleteHandler | null {
  switch (commandName) {
    case 'agent':
      return autocompleteHandlers.agent;
    case 'model':
      return autocompleteHandlers.model;
    default:
      return null;
  }
}

function resolveInteractionErrorMessage(error: unknown): string {
  if (error instanceof RuntimeError) {
    return error.message;
  }

  return 'Something went wrong while processing this command.';
}

async function sendInteractionReply(
  interaction: ChatInputCommandInteraction,
  message?: string,
  embeds?: EmbedBuilder[]
): Promise<void> {
  const reply = {
    content: message,
    embeds,
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(reply);
    return;
  }

  await interaction.reply(reply);
}

export async function handleInteractionCreate(
  options: RegisterInteractionCreateHandlerOptions,
  interaction: Interaction
): Promise<void> {
  if (interaction.isAutocomplete()) {
    const autocompleteHandler = resolveInteractionAutocompleteHandler(
      interaction.commandName,
      options.autocompleteHandlers ?? defaultInteractionAutocompleteHandlers
    );

    if (autocompleteHandler === null) {
      return;
    }

    if (!interaction.inGuild()) {
      await interaction.respond([]);
      return;
    }

    try {
      await autocompleteHandler(options.services, interaction);
    } catch (error) {
      logger.error(
        {
          err: toError(error),
          interactionId: interaction.id,
          commandName: interaction.commandName,
          channelId: interaction.channelId,
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
        'Failed to process Discord autocomplete interaction'
      );

      if (!interaction.responded) {
        try {
          await interaction.respond([]);
        } catch (replyError) {
          logger.error(
            {
              err: toError(replyError),
              interactionId: interaction.id,
              commandName: interaction.commandName,
              channelId: interaction.channelId,
              guildId: interaction.guildId,
              userId: interaction.user.id,
            },
            'Failed to send an autocomplete response'
          );
        }
      }
    }

    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const commandHandler = resolveInteractionCommandHandler(
    interaction.commandName,
    options.commandHandlers ?? defaultInteractionCommandHandlers
  );

  if (commandHandler === null) {
    return;
  }

  if (!interaction.inGuild()) {
    await sendInteractionReply(interaction, 'This command can only be used in a server thread.');
    return;
  }

  try {
    await interaction.deferReply();

    const result = await commandHandler(options.services, interaction);
    await sendInteractionReply(interaction, result.message, result.embeds);
  } catch (error) {
    const commandError = toError(error);
    const logContext = {
      err: commandError,
      interactionId: interaction.id,
      commandName: interaction.commandName,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
    };

    if (error instanceof RuntimeError) {
      logger.warn(logContext, 'Rejected Discord slash command');
    } else {
      logger.error(logContext, 'Failed to process Discord slash command');
    }

    try {
      await sendInteractionReply(interaction, resolveInteractionErrorMessage(error));
    } catch (replyError) {
      logger.error(
        {
          err: toError(replyError),
          interactionId: interaction.id,
          commandName: interaction.commandName,
          channelId: interaction.channelId,
          guildId: interaction.guildId,
          userId: interaction.user.id,
        },
        'Failed to send a slash-command reply'
      );
    }
  }
}

export function registerInteractionCreateHandler(
  client: Client,
  options: RegisterInteractionCreateHandlerOptions
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteractionCreate(options, interaction);
  });
}
