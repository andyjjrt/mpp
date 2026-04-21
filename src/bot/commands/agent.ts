import {
  EmbedBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { assertBoundManagedSessionThread } from '../../discord/threadGuards.js';
import type { OpencodeSdkContext } from '../../opencode/sdk.js';
import type { ThreadTaskQueue } from '../../pipeline/enqueue.js';
import type { ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import type { AppConfig } from '../../types.js';
import { RuntimeError, toError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import type { InteractionCommandResult } from '../events/interactionCreate.js';

const logger = createLogger({ module: 'bot' });

interface Agent {
  name: string;
  description?: string;
  mode: 'subagent' | 'primary' | 'all';
  builtIn: boolean;
  model?: { providerID: string; modelID: string };
}

export interface AgentCommandServices {
  config: AppConfig;
  opencodeContext: OpencodeSdkContext;
  threadSessionRepo: ThreadSessionRepo;
  threadTaskQueue: ThreadTaskQueue;
}

const AUTOCOMPLETE_LIMIT = 25;
const FOOTER_AGENT_LIMIT = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeOptionalString(value: string | null): string | null {
  const normalizedValue = value?.trim();

  return normalizedValue === undefined || normalizedValue.length === 0 ? null : normalizedValue;
}

function normalizeAgentModel(input: unknown): Agent['model'] {
  if (!isRecord(input)) {
    return undefined;
  }

  const providerID = normalizeOptionalString(
    typeof input.providerID === 'string' ? input.providerID : null
  );
  const modelID = normalizeOptionalString(typeof input.modelID === 'string' ? input.modelID : null);

  if (providerID === null || modelID === null) {
    return undefined;
  }

  return { providerID, modelID };
}

function normalizeAgent(input: unknown): Agent | null {
  if (!isRecord(input)) {
    return null;
  }

  const name = normalizeOptionalString(typeof input.name === 'string' ? input.name : null);

  if (name === null) {
    return null;
  }

  return {
    name,
    description:
      normalizeOptionalString(typeof input.description === 'string' ? input.description : null) ??
      undefined,
    mode:
      input.mode === 'subagent' || input.mode === 'primary' || input.mode === 'all'
        ? input.mode
        : 'all',
    builtIn: input.builtIn === true,
    model: normalizeAgentModel(input.model),
  };
}

function normalizeAgents(input: unknown): Agent[] {
  const values = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.agents)
      ? input.agents
      : [];

  return values
    .map((value) => normalizeAgent(value))
    .filter((agent): agent is Agent => agent !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function formatAgentModel(agent: Agent): string {
  if (agent.model === undefined) {
    return 'Default';
  }

  return `\`${agent.model.providerID}/${agent.model.modelID}\``;
}

function sortAgents(agents: readonly Agent[], currentAgent: string | null): Agent[] {
  return [...agents].sort((left, right) => {
    const leftCurrent = left.name === currentAgent ? 1 : 0;
    const rightCurrent = right.name === currentAgent ? 1 : 0;

    if (leftCurrent !== rightCurrent) {
      return rightCurrent - leftCurrent;
    }

    return left.name.localeCompare(right.name);
  });
}

function summarizeAgents(agents: readonly Agent[]): string {
  if (agents.length === 0) {
    return 'none';
  }

  const visibleAgents = agents.slice(0, FOOTER_AGENT_LIMIT).map((agent) => agent.name);
  const suffix =
    agents.length > FOOTER_AGENT_LIMIT ? `, +${agents.length - FOOTER_AGENT_LIMIT} more` : '';

  return `${visibleAgents.join(', ')}${suffix}`;
}

function createAgentViewEmbed(agents: Agent[], currentAgentName: string | null): EmbedBuilder {
  const currentAgent =
    currentAgentName === null
      ? null
      : (agents.find((agent) => agent.name === currentAgentName) ?? null);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Current AI Agent')
    .setFooter({
      text: `Available agents: ${summarizeAgents(sortAgents(agents, currentAgentName))}`,
    });

  if (currentAgentName === null) {
    return embed.setDescription('This thread is using the default agent.');
  }

  embed.setDescription(`This thread is using \`${currentAgentName}\`.`);

  if (currentAgent !== null) {
    embed.addFields(
      {
        name: 'Description',
        value: currentAgent.description?.trim() || 'No description available.',
        inline: false,
      },
      {
        name: 'Mode',
        value: `\`${currentAgent.mode}\``,
        inline: true,
      },
      {
        name: 'Model',
        value: formatAgentModel(currentAgent),
        inline: true,
      }
    );
  } else {
    embed.addFields({
      name: 'Status',
      value: 'The saved agent is not present in the current OpenCode agent list.',
      inline: false,
    });
  }

  return embed;
}

function createAgentSuccessEmbed(agent: Agent, agents: Agent[]): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('Agent Updated')
    .setDescription(`This thread will now use \`${agent.name}\`.`)
    .setFooter({ text: `Available agents: ${summarizeAgents(sortAgents(agents, agent.name))}` });
}

function createAgentErrorEmbed(error: string): EmbedBuilder {
  return new EmbedBuilder().setColor(0xed4245).setTitle('Agent Error').setDescription(error);
}

async function loadAgents(services: AgentCommandServices): Promise<Agent[]> {
  const agents = await services.opencodeContext.client.app.agents();

  return normalizeAgents(agents);
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
    .map((option) => ({ name: option.label, value: option.value }));
}

export async function handleAgentAutocomplete(
  services: AgentCommandServices,
  interaction: AutocompleteInteraction
): Promise<void> {
  try {
    const agents = await loadAgents(services);

    await interaction.respond(
      createAutocompleteChoices(
        agents.map((agent) => ({ label: agent.name, value: agent.name })),
        interaction.options.getFocused()
      )
    );
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
      'Failed to process /agent autocomplete'
    );

    if (!interaction.responded) {
      await interaction.respond([]);
    }
  }
}

function resolveRequestedAgentName(interaction: ChatInputCommandInteraction): string | null {
  return normalizeOptionalString(interaction.options.getString('name'));
}

async function setRequestedAgent(
  services: AgentCommandServices,
  interaction: ChatInputCommandInteraction,
  requestedAgentName: string
): Promise<InteractionCommandResult> {
  const { thread } = assertBoundManagedSessionThread(services.threadSessionRepo, interaction);

  const agents = await loadAgents(services);
  const selectedAgent = agents.find((agent) => agent.name === requestedAgentName);

  if (selectedAgent === undefined) {
    return {
      embeds: [createAgentErrorEmbed(`Agent \`${requestedAgentName}\` is not available.`)],
    };
  }

  await services.threadTaskQueue.enqueue(thread.id, async () => {
    services.threadSessionRepo.setAgent(thread.id, selectedAgent.name);
  });

  return {
    embeds: [createAgentSuccessEmbed(selectedAgent, agents)],
  };
}

export async function handleAgentCommand(
  services: AgentCommandServices,
  interaction: ChatInputCommandInteraction
): Promise<InteractionCommandResult> {
  try {
    const { thread } = assertBoundManagedSessionThread(services.threadSessionRepo, interaction);
    const requestedAgentName = resolveRequestedAgentName(interaction);

    if (requestedAgentName !== null) {
      return setRequestedAgent(services, interaction, requestedAgentName);
    }

    const agents = await loadAgents(services);
    const currentAgent = services.threadSessionRepo.findPromptPreferences(thread.id).agent;

    return {
      embeds: [createAgentViewEmbed(agents, currentAgent)],
    };
  } catch (error) {
    if (error instanceof RuntimeError) {
      return {
        embeds: [createAgentErrorEmbed(error.message)],
      };
    }

    throw error;
  }
}
