import {
  ComponentType,
  EmbedBuilder,
  Events,
  MessageFlags,
  type ButtonInteraction,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { APIMessageTopLevelComponent } from 'discord-api-types/v10';

import {
  QUESTION_CUSTOM_ANSWER_FIELD_ID,
  createQuestionAnswerModal,
  createCompletedQuestionComponents,
  parseQuestionModalCustomId,
  parseQuestionOptionCustomId,
  parseQuestionOtherCustomId,
  parseQuestionSelectCustomId,
} from '../../discord/questionUi.js';
import { assertBoundManagedSessionThread } from '../../discord/threadGuards.js';
import { submitQuestionReply } from '../../opencode/questionReplies.js';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function findButtonLabelByCustomId(value: unknown, customId: string): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const label = findButtonLabelByCustomId(entry, customId);
      if (label !== null) return label;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.custom_id === customId && typeof value.label === 'string') {
    const normalized = value.label.trim();
    return normalized.length > 0 ? normalized : null;
  }
  if ('components' in value) {
    const label = findButtonLabelByCustomId(value.components, customId);
    if (label !== null) return label;
  }
  if ('accessory' in value) {
    const label = findButtonLabelByCustomId(value.accessory, customId);
    if (label !== null) return label;
  }
  return null;
}

function resolveButtonInteractionLabel(interaction: ButtonInteraction): string | null {
  // For Component v2, the button data is available directly on interaction.component
  const component = interaction.component;
  if (component && 'label' in component && typeof component.label === 'string') {
    const normalized = component.label.trim();
    return normalized.length > 0 ? normalized : null;
  }
  // Fallback: try to find in message components
  return findButtonLabelByCustomId(interaction.message.components, interaction.customId);
}

function toApiTopLevelComponents(
  components: readonly { toJSON(): APIMessageTopLevelComponent }[]
): APIMessageTopLevelComponent[] {
  return components.map((c) => c.toJSON());
}

function updateQuestionContainerAtIndex(
  components: readonly { toJSON(): APIMessageTopLevelComponent }[],
  questionIndex: number,
  replacement: APIMessageTopLevelComponent
): APIMessageTopLevelComponent[] {
  const api = toApiTopLevelComponents(components);
  if (questionIndex < 0 || questionIndex >= api.length) {
    throw new RuntimeError('Question index out of bounds', 400);
  }
  api[questionIndex] = replacement;
  return api;
}

function createCompletedQuestionComponentForAnswers(
  answers: readonly string[]
): APIMessageTopLevelComponent {
  const [component] = createCompletedQuestionComponents(answers);
  if (component === undefined) {
    throw new RuntimeError('Missing completed question component', 500);
  }
  return component;
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

async function handleQuestionSelectInteraction(
  services: InteractionCreateServices,
  interaction: StringSelectMenuInteraction
): Promise<boolean> {
  const parsed = parseQuestionSelectCustomId(interaction.customId);
  if (!parsed) return false;
  const { thread, sessionId } = assertBoundManagedSessionThread(
    services.threadSessionRepo,
    interaction
  );
  await interaction.deferUpdate();
  await services.threadTaskQueue.enqueue(thread.id, async () => {
    await submitQuestionReply(services.opencodeContext, {
      questionId: parsed.questionId,
      answers: [interaction.values],
    });
    await interaction.message.edit({
      components: updateQuestionContainerAtIndex(
        interaction.message.components,
        parsed.questionIndex,
        createCompletedQuestionComponentForAnswers(interaction.values)
      ),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  });
  return true;
}

async function handleQuestionOptionInteraction(
  services: InteractionCreateServices,
  interaction: ButtonInteraction
): Promise<boolean> {
  const parsed = parseQuestionOptionCustomId(interaction.customId);
  if (!parsed) return false;
  const { thread, sessionId } = assertBoundManagedSessionThread(
    services.threadSessionRepo,
    interaction
  );
  const answer = resolveButtonInteractionLabel(interaction);
  if (!answer) throw new RuntimeError('Could not resolve answer', 400);
  logger.debug(
    {
      interactionId: interaction.id,
      customId: interaction.customId,
      sessionId,
      questionId: parsed.questionId,
      questionIndex: parsed.questionIndex,
      optionIndex: parsed.optionIndex,
      answer,
      messageId: interaction.message.id,
    },
    'Preparing question button reply submission'
  );
  await interaction.deferUpdate();
  await services.threadTaskQueue.enqueue(thread.id, async () => {
    await submitQuestionReply(services.opencodeContext, {
      questionId: parsed.questionId,
      answers: [[answer]],
    });
    await interaction.message.edit({
      components: updateQuestionContainerAtIndex(
        interaction.message.components,
        parsed.questionIndex,
        createCompletedQuestionComponentForAnswers([answer])
      ),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  });
  return true;
}

async function handleQuestionOtherAnswerInteraction(
  services: InteractionCreateServices,
  interaction: ButtonInteraction
): Promise<boolean> {
  const parsed = parseQuestionOtherCustomId(interaction.customId);
  if (!parsed) return false;
  assertBoundManagedSessionThread(services.threadSessionRepo, interaction);
  await interaction.showModal(
    createQuestionAnswerModal(parsed.questionId, parsed.questionIndex, interaction.message.id)
  );
  return true;
}

async function handleQuestionModalSubmitInteraction(
  services: InteractionCreateServices,
  interaction: ModalSubmitInteraction
): Promise<boolean> {
  const parsed = parseQuestionModalCustomId(interaction.customId);
  if (!parsed) return false;
  const { thread, sessionId } = assertBoundManagedSessionThread(
    services.threadSessionRepo,
    interaction
  );
  const answer = interaction.fields.getTextInputValue(QUESTION_CUSTOM_ANSWER_FIELD_ID).trim();
  if (!answer) throw new RuntimeError('Empty answer', 400);
  logger.debug(
    {
      interactionId: interaction.id,
      customId: interaction.customId,
      sessionId,
      questionId: parsed.questionId,
      questionIndex: parsed.questionIndex,
      answer,
      sourceMessageId: parsed.messageId,
    },
    'Preparing question modal reply submission'
  );
  await interaction.deferUpdate();
  await services.threadTaskQueue.enqueue(thread.id, async () => {
    const msg = await thread.messages.fetch(parsed.messageId).catch(() => null);
    if (!msg) throw new RuntimeError('Message not found', 404);
    await submitQuestionReply(services.opencodeContext, {
      questionId: parsed.questionId,
      answers: [[answer]],
    });
    await msg.edit({
      components: updateQuestionContainerAtIndex(
        msg.components,
        parsed.questionIndex,
        createCompletedQuestionComponentForAnswers([answer])
      ),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    });
  });
  return true;
}

async function handleQuestionInteraction(
  services: InteractionCreateServices,
  interaction: Interaction
): Promise<boolean> {
  if (!interaction.inGuild()) return false;
  if (interaction.isStringSelectMenu())
    return handleQuestionSelectInteraction(services, interaction);
  if (interaction.isButton()) {
    if (await handleQuestionOptionInteraction(services, interaction)) return true;
    return handleQuestionOtherAnswerInteraction(services, interaction);
  }
  if (interaction.isModalSubmit())
    return handleQuestionModalSubmitInteraction(services, interaction);
  return false;
}

async function sendNonCommandInteractionErrorReply(
  interaction: Interaction,
  message: string
): Promise<void> {
  if (!interaction.isRepliable()) return;
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(message);
    return;
  }
  await interaction.reply({ content: message, ephemeral: true, allowedMentions: { parse: [] } });
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

  try {
    if (await handleQuestionInteraction(options.services, interaction)) return;
  } catch (error) {
    logger.warn(
      { err: toError(error), interactionId: interaction.id },
      'Question interaction failed'
    );
    try {
      await sendNonCommandInteractionErrorReply(interaction, resolveInteractionErrorMessage(error));
    } catch {
      // ignore
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
