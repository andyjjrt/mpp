import { Events, type ChatInputCommandInteraction, type Client, type Interaction } from 'discord.js';

import type { ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import { RuntimeError, toError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import { handleJoinCommand } from '../commands/join.js';
import { handleLeaveCommand } from '../commands/leave.js';

const logger = createLogger({ module: 'app' });

interface InteractionCreateServices {
  threadSessionRepo: ThreadSessionRepo;
}

export interface InteractionCommandResult {
  message: string;
}

export interface RegisterInteractionCreateHandlerOptions {
  services: InteractionCreateServices;
  commandHandlers?: InteractionCommandHandlers;
}

export type InteractionCommandHandler = (
  services: InteractionCreateServices,
  interaction: ChatInputCommandInteraction,
) => Promise<InteractionCommandResult>;

export interface InteractionCommandHandlers {
  join: InteractionCommandHandler;
  leave: InteractionCommandHandler;
}

const defaultInteractionCommandHandlers: InteractionCommandHandlers = {
  join: handleJoinCommand,
  leave: handleLeaveCommand,
};

function resolveInteractionCommandHandler(
  commandName: string,
  commandHandlers: InteractionCommandHandlers,
): InteractionCommandHandler | null {
  switch (commandName) {
    case 'join':
      return commandHandlers.join;
    case 'leave':
      return commandHandlers.leave;
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

async function sendInteractionReply(interaction: ChatInputCommandInteraction, message: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: message });
    return;
  }

  await interaction.reply({ content: message });
}

export async function handleInteractionCreate(
  options: RegisterInteractionCreateHandlerOptions,
  interaction: Interaction,
): Promise<void> {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const commandHandler = resolveInteractionCommandHandler(
    interaction.commandName,
    options.commandHandlers ?? defaultInteractionCommandHandlers,
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
    await sendInteractionReply(interaction, result.message);
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
        'Failed to send a slash-command reply',
      );
    }
  }
}

export function registerInteractionCreateHandler(client: Client, options: RegisterInteractionCreateHandlerOptions): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteractionCreate(options, interaction);
  });
}
