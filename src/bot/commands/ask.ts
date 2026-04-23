import {
  ChannelType,
  EmbedBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { InteractionCommandResult } from '../events/interactionCreate.js';
import { handleAgentAutocomplete } from './agent.js';
import { handleModelAutocomplete } from './model.js';
import { createSessionThreadFromMessage } from '../../discord/sessionThreads.js';
import type { OpencodeSdkContext } from '../../opencode/sdk.js';
import { createSession } from '../../opencode/sessions.js';
import type { ThreadTaskQueue } from '../../pipeline/enqueue.js';
import { handleThreadMessage } from '../../pipeline/handleThreadMessage.js';
import type { ThreadModelPreference, ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import type { AppConfig } from '../../types.js';
import { RuntimeError, toError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ module: 'bot' });
const SUCCESS_EMBED_COLOR = 0x57f287;

export interface AskCommandServices {
  config: AppConfig;
  opencodeContext: OpencodeSdkContext;
  threadSessionRepo: ThreadSessionRepo;
  threadTaskQueue: ThreadTaskQueue;
}

function requirePrompt(prompt: string): string {
  const normalizedPrompt = prompt.trim();

  if (normalizedPrompt.length === 0) {
    throw new RuntimeError('Prompt must be a non-empty string.', 400);
  }

  return normalizedPrompt;
}

function normalizeOptionalString(value: string | null): string | null {
  const normalizedValue = value?.trim();
  return normalizedValue === undefined || normalizedValue.length === 0 ? null : normalizedValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireAgentName(value: string | null): string | null {
  return normalizeOptionalString(value);
}

function parseModelValue(value: string | null): ThreadModelPreference | null {
  const normalizedValue = normalizeOptionalString(value);

  if (normalizedValue === null) {
    return null;
  }

  const separatorIndex = normalizedValue.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === normalizedValue.length - 1) {
    throw new RuntimeError('Model must use the format `provider/model`.', 400);
  }

  const providerID = normalizeOptionalString(normalizedValue.slice(0, separatorIndex));
  const modelID = normalizeOptionalString(normalizedValue.slice(separatorIndex + 1));

  if (providerID === null || modelID === null) {
    throw new RuntimeError('Model must use the format `provider/model`.', 400);
  }

  return { providerID, modelID };
}

function resolveThreadTitle(prompt: string, interactionId: string): string {
  const normalizedPrompt = prompt.trim();
  return normalizedPrompt.length > 0 ? normalizedPrompt : `Session ${interactionId}`;
}

async function resolveMonitoredChannelLabel(
  config: AppConfig,
  interaction: ChatInputCommandInteraction
): Promise<string> {
  const cachedChannel = interaction.guild?.channels.cache.get(config.discord.monitoredChannelId);

  if (
    cachedChannel?.isTextBased() &&
    'name' in cachedChannel &&
    typeof cachedChannel.name === 'string'
  ) {
    return `#${cachedChannel.name}`;
  }

  const fetchedChannel = await interaction.client.channels.fetch(config.discord.monitoredChannelId);

  if (
    fetchedChannel?.isTextBased() &&
    'name' in fetchedChannel &&
    typeof fetchedChannel.name === 'string'
  ) {
    return `#${fetchedChannel.name}`;
  }

  return `<#${config.discord.monitoredChannelId}>`;
}

async function enqueueThreadSetup(
  services: AskCommandServices,
  interaction: ChatInputCommandInteraction,
  threadId: string,
  threadName: string,
  options: {
    firstUserId: string;
    agent: string | null;
    model: ThreadModelPreference | null;
  }
): Promise<string> {
  return services.threadTaskQueue.enqueue(threadId, async () => {
    const threadChannel = await interaction.client.channels.fetch(threadId);

    if (threadChannel === null || !threadChannel.isThread()) {
      throw new RuntimeError(`Expected thread channel "${threadId}" to exist after creation.`);
    }

    const existingSessionId = services.threadSessionRepo.findSessionId(threadId);

    if (existingSessionId !== null) {
      services.threadSessionRepo.setFirstUserId(threadId, options.firstUserId);
      if (options.agent !== null) {
        services.threadSessionRepo.setAgent(threadId, options.agent);
      }
      if (options.model !== null) {
        services.threadSessionRepo.setModel(threadId, options.model);
      }

      return existingSessionId;
    }

    const session = await createSession(services.opencodeContext, { title: threadName });
    services.threadSessionRepo.bind(threadId, session.id);
    services.threadSessionRepo.setFirstUserId(threadId, options.firstUserId);
    if (options.agent !== null) {
      services.threadSessionRepo.setAgent(threadId, options.agent);
    }
    if (options.model !== null) {
      services.threadSessionRepo.setModel(threadId, options.model);
    }

    logger.info(
      {
        interactionId: interaction.id,
        threadId,
        sessionId: session.id,
        userId: options.firstUserId,
        queuePending: services.threadTaskQueue.hasPending(threadId),
      },
      'Created managed thread session for /ask'
    );

    return session.id;
  });
}

async function enqueueThreadPrompt(
  services: AskCommandServices,
  interaction: ChatInputCommandInteraction,
  threadId: string,
  prompt: string,
  firstUserId: string
): Promise<void> {
  await services.threadTaskQueue.enqueue(threadId, async () => {
    const threadChannel = await interaction.client.channels.fetch(threadId);

    if (threadChannel === null || !threadChannel.isThread()) {
      throw new RuntimeError(`Expected thread channel "${threadId}" to exist before prompting.`);
    }

    const result = await handleThreadMessage(
      {
        opencode: services.opencodeContext,
        threadSessionRepo: services.threadSessionRepo,
        enableCompletionMention: services.config.enableCompletionMention,
        enableCompletionReport: services.config.enableCompletionReport,
      },
      {
        thread: threadChannel,
        text: prompt,
        firstUserId,
      }
    );

    logger.info(
      {
        interactionId: interaction.id,
        threadId,
        sessionId: result.sessionId,
        createdSession: result.createdSession,
        assistantPartCount: result.promptResult.parts.length,
        terminalEvent: result.promptResult.terminalEvent,
        queuePending: services.threadTaskQueue.hasPending(threadId),
      },
      'Processed /ask prompt for managed thread'
    );
  });
}

export async function handleAskCommand(
  services: AskCommandServices,
  interaction: ChatInputCommandInteraction
): Promise<InteractionCommandResult> {
  try {
    if (interaction.channelId !== services.config.discord.monitoredChannelId) {
      const monitoredChannelLabel = await resolveMonitoredChannelLabel(
        services.config,
        interaction
      );
      throw new RuntimeError(`This command can only be used in ${monitoredChannelLabel}`);
    }

    const prompt = requirePrompt(interaction.options.getString('prompt', true));
    const requestedAgent = requireAgentName(interaction.options.getString('agent'));
    const requestedModel = parseModelValue(interaction.options.getString('model'));
    const channel = interaction.channel;

    if (
      channel === null ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
    ) {
      throw new RuntimeError('This command requires a guild text channel.', 400);
    }

    logger.debug(
      {
        interactionId: interaction.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      },
      'Starting /ask command'
    );

    const placeholderMessage = await channel.send({
      content: `**Question**\n${prompt}`,
      allowedMentions: { parse: [] },
    });
    const thread = await createSessionThreadFromMessage(
      placeholderMessage,
      resolveThreadTitle(prompt, interaction.id),
      interaction.user.id
    );

    await enqueueThreadSetup(services, interaction, thread.id, thread.name, {
      firstUserId: interaction.user.id,
      agent: requestedAgent,
      model: requestedModel,
    });
    await enqueueThreadPrompt(services, interaction, thread.id, prompt, interaction.user.id);

    const successEmbed = new EmbedBuilder()
      .setColor(SUCCESS_EMBED_COLOR)
      .setTitle('Ask Created')
      .setDescription(`Created <#${thread.id}>`);

    return {
      embeds: [successEmbed],
    };
  } catch (error) {
    logger.error(
      {
        err: toError(error),
        interactionId: interaction.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      },
      'Failed to process /ask command'
    );

    if (error instanceof RuntimeError) {
      throw error;
    }

    throw new RuntimeError(toError(error).message);
  }
}

export async function handleAskAutocomplete(
  services: AskCommandServices,
  interaction: AutocompleteInteraction
): Promise<void> {
  const focusedOption = interaction.options.getFocused(true);

  if (focusedOption.name === 'agent') {
    await handleAgentAutocomplete(services, interaction);
    return;
  }

  if (focusedOption.name === 'model') {
    await handleModelAutocomplete(services, interaction);
    return;
  }

  await interaction.respond([]);
}
