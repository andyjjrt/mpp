import {
  ChannelType,
  EmbedBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { getSession } from '../../opencode/sessions.js';
import type { OpencodeSdkContext } from '../../opencode/sdk.js';
import type { ThreadTaskQueue } from '../../pipeline/enqueue.js';
import type { ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import { RuntimeError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import type { InteractionCommandResult } from '../events/interactionCreate.js';

const logger = createLogger({ module: 'bot' });

export interface SessionLinkCommandServices {
  config: { discord: { monitoredChannelId: string } };
  opencodeContext: OpencodeSdkContext;
  threadSessionRepo: ThreadSessionRepo;
  threadTaskQueue: ThreadTaskQueue;
}

interface Session {
  id: string;
  title?: string;
  directory?: string;
  parentID?: string;
}

function createSuccessEmbed(sessionId: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Session Linked')
    .setDescription(`This thread is now linked to session \`${sessionId}\`.`);
}

function createInfoEmbed(sessionId: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Already Linked')
    .setDescription(`This thread is already linked to session \`${sessionId}\`.`);
}

function createErrorEmbed(error: string): EmbedBuilder {
  return new EmbedBuilder().setColor(0xed4245).setTitle('Session Link Error').setDescription(error);
}

function normalizeOptionalString(value: string | null): string | null {
  const normalizedValue = value?.trim();
  return normalizedValue === undefined || normalizedValue.length === 0 ? null : normalizedValue;
}

async function resolveMonitoredChannelLabel(
  config: { discord: { monitoredChannelId: string } },
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

async function loadSessions(services: SessionLinkCommandServices): Promise<Session[]> {
  const response = await services.opencodeContext.client.session.list();
  const sessions = (response.data as Session[]) ?? [];
  const configDirectory = services.opencodeContext.directory;

  // Filter sessions by configured directory if set
  if (configDirectory) {
    return sessions.filter((session) => session.directory === configDirectory && !session.parentID);
  }

  return sessions;
}

const AUTOCOMPLETE_LIMIT = 25;

const MAX_CHOICE_NAME_LENGTH = 100;

function truncateChoiceName(name: string): string {
  if (name.length <= MAX_CHOICE_NAME_LENGTH) {
    return name;
  }
  // Leave room for ellipsis
  return name.slice(0, MAX_CHOICE_NAME_LENGTH - 1) + '…';
}

function createAutocompleteChoices(
  options: ReadonlyArray<{ label: string; value: string }>,
  query: string
): Array<{ name: string; value: string }> {
  const normalizedQuery = query.trim().toLowerCase();

  return options
    .filter(
      (option) =>
        normalizedQuery.length === 0 || option.label.toLowerCase().includes(normalizedQuery)
    )
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map((option) => ({ name: truncateChoiceName(option.label), value: option.value }));
}

export async function handleSessionLinkAutocomplete(
  services: SessionLinkCommandServices,
  interaction: AutocompleteInteraction
): Promise<void> {
  try {
    const sessions = await loadSessions(services);

    await interaction.respond(
      createAutocompleteChoices(
        sessions.map((session) => ({
          label: session.title ? `${session.title} (${session.id})` : session.id,
          value: session.id,
        })),
        interaction.options.getFocused()
      )
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        interactionId: interaction.id,
        commandName: interaction.commandName,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      },
      'Failed to process /session-link autocomplete'
    );

    if (!interaction.responded) {
      await interaction.respond([]);
    }
  }
}

export async function handleSessionLinkCommand(
  services: SessionLinkCommandServices,
  interaction: ChatInputCommandInteraction
): Promise<InteractionCommandResult> {
  try {
    // Validate we're in the monitored channel
    if (interaction.channelId !== services.config.discord.monitoredChannelId) {
      const monitoredChannelLabel = await resolveMonitoredChannelLabel(
        services.config,
        interaction
      );
      throw new RuntimeError(`This command can only be used in ${monitoredChannelLabel}`);
    }

    // Get and validate session_id option
    const sessionIdInput = interaction.options.getString('session_id', true);
    const sessionId = normalizeOptionalString(sessionIdInput);

    if (sessionId === null) {
      return {
        embeds: [createErrorEmbed('Session ID must be a non-empty string.')],
      };
    }

    // Check if there's already a thread for this session in the repo
    // We need to create a new thread and bind it to the existing session
    const channel = interaction.channel;

    if (
      channel === null ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
    ) {
      throw new RuntimeError('This command requires a guild text channel.', 400);
    }

    // Create a placeholder message to start a thread
    const placeholderMessage = await channel.send({
      content: `Linking to session \`${sessionId}\`...`,
      allowedMentions: { parse: [] },
    });

    // Create thread from the placeholder message
    const thread = await placeholderMessage.startThread({
      name: `Session ${sessionId.slice(0, 8)}`,
      reason: 'Session link thread creation',
    });

    // Add the user who triggered the command to the thread
    try {
      await thread.members.add(interaction.user.id);
    } catch {
      // Ignore errors when adding member (e.g., user not in guild)
    }

    // Validate the session exists in OpenCode
    await getSession(services.opencodeContext, sessionId);

    // Bind the session to the thread
    await services.threadTaskQueue.enqueue(thread.id, async () => {
      services.threadSessionRepo.bind(thread.id, sessionId);
      // Set first_user_id for voice gating and mention behavior
      services.threadSessionRepo.setFirstUserId(thread.id, interaction.user.id);
    });

    // Update the placeholder message to indicate success
    await placeholderMessage.edit({
      content: `**Session Link**\nLinked to session \`${sessionId}\``,
    });

    return {
      embeds: [createSuccessEmbed(sessionId)],
    };
  } catch (error) {
    if (error instanceof RuntimeError) {
      return {
        embeds: [createErrorEmbed(error.message)],
      };
    }

    throw error;
  }
}
