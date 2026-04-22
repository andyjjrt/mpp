import {
  EmbedBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { AppConfig } from '../../types.js';
import { assertBoundManagedSessionThread } from '../../discord/threadGuards.js';
import type { OpencodeSdkContext } from '../../opencode/sdk.js';
import type { ThreadTaskQueue } from '../../pipeline/enqueue.js';
import type { ThreadModelPreference, ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import { RuntimeError, toError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import type { InteractionCommandResult } from '../events/interactionCreate.js';

const logger = createLogger({ module: 'bot' });

const SUCCESS_EMBED_COLOR = 0x57f287;
const ERROR_EMBED_COLOR = 0xed4245;
const INFO_EMBED_COLOR = 0x5865f2;
const AUTOCOMPLETE_LIMIT = 25;
const FOOTER_PROVIDER_LIMIT = 5;
const PROVIDER_CATALOG_CACHE_TTL_MS = 30_000;

type ProviderModelSummary = { id: string; name: string };
type ProviderSummary = { id: string; name: string; models: ProviderModelSummary[] };
type ProviderCatalog = { providers: ProviderSummary[]; defaultModel: ThreadModelPreference | null };
type ProviderCatalogCacheEntry = { expiresAt: number; catalog: ProviderCatalog };

let providerCatalogCache: ProviderCatalogCacheEntry | null = null;

export interface ModelCommandServices {
  config: AppConfig;
  opencodeContext: OpencodeSdkContext;
  threadSessionRepo: ThreadSessionRepo;
  threadTaskQueue: ThreadTaskQueue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeOptionalString(value: string | null): string | null {
  const normalizedValue = value?.trim();

  return normalizedValue === undefined || normalizedValue.length === 0 ? null : normalizedValue;
}

function requireOptionValue(name: string, value: string | null): string {
  const normalizedValue = normalizeOptionalString(value);

  if (normalizedValue === null) {
    throw new RuntimeError(`${name} must be a non-empty string.`, 400);
  }

  return normalizedValue;
}

function formatProviderModelValue(model: ThreadModelPreference): string {
  return `${model.providerID}/${model.modelID}`;
}

function parseProviderModelValue(
  value: string | null
): { providerId: string; modelId: string } | null {
  const normalizedValue = normalizeOptionalString(value);

  if (normalizedValue === null) {
    return null;
  }

  const separatorIndex = normalizedValue.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === normalizedValue.length - 1) {
    throw new RuntimeError('Model must use the format `provider/model`.', 400);
  }

  const providerId = normalizeOptionalString(normalizedValue.slice(0, separatorIndex));
  const modelId = normalizeOptionalString(normalizedValue.slice(separatorIndex + 1));

  if (providerId === null || modelId === null) {
    throw new RuntimeError('Model must use the format `provider/model`.', 400);
  }

  return { providerId, modelId };
}

function normalizeProviderModel(input: unknown): ProviderModelSummary | null {
  if (!isRecord(input)) {
    return null;
  }

  const id = normalizeOptionalString(typeof input.id === 'string' ? input.id : null);

  if (id === null) {
    return null;
  }

  return {
    id,
    name: normalizeOptionalString(typeof input.name === 'string' ? input.name : null) ?? id,
  };
}

function normalizeProviderModels(input: unknown): ProviderModelSummary[] {
  const values = Array.isArray(input) ? input : isRecord(input) ? Object.values(input) : [];

  return values
    .map((value) => normalizeProviderModel(value))
    .filter((model): model is ProviderModelSummary => model !== null)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function normalizeProvider(input: unknown): ProviderSummary | null {
  if (!isRecord(input)) {
    return null;
  }

  const id = normalizeOptionalString(typeof input.id === 'string' ? input.id : null);

  if (id === null) {
    return null;
  }

  return {
    id,
    name: normalizeOptionalString(typeof input.name === 'string' ? input.name : null) ?? id,
    models: normalizeProviderModels(input.models),
  };
}

function resolveDefaultModel(input: unknown): ThreadModelPreference | null {
  if (!isRecord(input) || !('default' in input) || !isRecord(input.default)) {
    return null;
  }

  const legacyProvider = normalizeOptionalString(
    typeof input.default.provider === 'string'
      ? input.default.provider
      : typeof input.default.providerID === 'string'
        ? input.default.providerID
        : null
  );
  const legacyModel = normalizeOptionalString(
    typeof input.default.model === 'string'
      ? input.default.model
      : typeof input.default.modelID === 'string'
        ? input.default.modelID
        : null
  );

  if (legacyProvider !== null && legacyModel !== null) {
    return {
      providerID: legacyProvider,
      modelID: legacyModel,
    };
  }

  const [providerEntry] = Object.entries(input.default);

  if (providerEntry === undefined) {
    return null;
  }

  const [provider, defaultModel] = providerEntry;
  const normalizedProvider = normalizeOptionalString(provider);
  const model = normalizeOptionalString(typeof defaultModel === 'string' ? defaultModel : null);

  if (normalizedProvider === null || model === null) {
    return null;
  }

  return {
    providerID: normalizedProvider,
    modelID: model,
  };
}

function normalizeProviderCatalog(input: unknown): ProviderCatalog {
  const providers =
    isRecord(input) && Array.isArray(input.providers)
      ? input.providers
          .map((provider) => normalizeProvider(provider))
          .filter((provider): provider is ProviderSummary => provider !== null)
          .sort(
            (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
          )
      : [];

  return {
    providers,
    defaultModel: resolveDefaultModel(input),
  };
}

function unwrapResponseData(input: unknown): unknown {
  if (!isRecord(input) || !('data' in input)) {
    return input;
  }

  return input.data;
}

function summarizeProviders(providers: readonly ProviderSummary[]): string {
  if (providers.length === 0) {
    return 'none';
  }

  const visibleProviders = providers.slice(0, FOOTER_PROVIDER_LIMIT).map((provider) => provider.id);
  const suffix =
    providers.length > FOOTER_PROVIDER_LIMIT
      ? `, +${providers.length - FOOTER_PROVIDER_LIMIT} more`
      : '';

  return `${visibleProviders.join(', ')}${suffix}`;
}

export function createModelErrorEmbed(error: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ERROR_EMBED_COLOR)
    .setTitle('Model Command Failed')
    .setDescription(error);
}

function createModelViewEmbed(
  providers: ProviderCatalog,
  currentModel: ThreadModelPreference | null
): EmbedBuilder {
  const effectiveModel = currentModel ?? providers.defaultModel;
  const embed = new EmbedBuilder()
    .setColor(INFO_EMBED_COLOR)
    .setTitle('Current AI Model')
    .setFooter({ text: `Available providers: ${summarizeProviders(providers.providers)}` });

  if (effectiveModel === null) {
    embed.setDescription(
      'No thread-specific model is set, and OpenCode did not report a default model.'
    );
    return embed;
  }

  embed.setDescription(
    currentModel === null
      ? `This thread is using the default model \`${effectiveModel.providerID}/${effectiveModel.modelID}\`.`
      : `This thread is using \`${effectiveModel.providerID}/${effectiveModel.modelID}\`.`
  );

  embed.addFields({
    name: 'Source',
    value: currentModel === null ? 'OpenCode default' : 'Thread preference',
    inline: true,
  });

  if (providers.defaultModel !== null) {
    embed.addFields({
      name: 'Default',
      value: `\`${providers.defaultModel.providerID}/${providers.defaultModel.modelID}\``,
      inline: true,
    });
  }

  return embed;
}

function createModelSuccessEmbed(
  model: ThreadModelPreference,
  providers: ProviderCatalog
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(SUCCESS_EMBED_COLOR)
    .setTitle('Model Preference Updated')
    .setDescription(`This thread will now use \`${model.providerID}/${model.modelID}\`.`)
    .setFooter({ text: `Available providers: ${summarizeProviders(providers.providers)}` });
}

function findProvider(providers: ProviderCatalog, providerId: string): ProviderSummary {
  const provider = providers.providers.find((candidate) => candidate.id === providerId);

  if (provider === undefined) {
    throw new RuntimeError(`Unknown provider: ${providerId}.`, 400);
  }

  return provider;
}

function assertProviderModel(provider: ProviderSummary, modelId: string): ThreadModelPreference {
  const model = provider.models.find((candidate) => candidate.id === modelId);

  if (model === undefined) {
    throw new RuntimeError(`Unknown model \`${modelId}\` for provider \`${provider.id}\`.`, 400);
  }

  return {
    providerID: provider.id,
    modelID: model.id,
  };
}

async function loadProviderCatalog(services: ModelCommandServices): Promise<ProviderCatalog> {
  if (providerCatalogCache !== null && providerCatalogCache.expiresAt > Date.now()) {
    return providerCatalogCache.catalog;
  }

  const catalog = await services.opencodeContext.client.config.providers();
  const normalizedCatalog = normalizeProviderCatalog(unwrapResponseData(catalog));

  providerCatalogCache = {
    catalog: normalizedCatalog,
    expiresAt: Date.now() + PROVIDER_CATALOG_CACHE_TTL_MS,
  };

  return normalizedCatalog;
}

function resolveRequestedModel(
  interaction: ChatInputCommandInteraction
): { providerId: string; modelId: string } | null {
  return parseProviderModelValue(interaction.options.getString('model'));
}

function createAutocompleteChoices(
  options: ReadonlyArray<{ label: string; value: string }>,
  query: string
): Array<{ name: string; value: string }> {
  const normalizedQuery = query.trim().toLowerCase();

  return options
    .filter(
      (option) =>
        normalizedQuery.length === 0 ||
        option.label.toLowerCase().includes(normalizedQuery) ||
        option.value.toLowerCase().includes(normalizedQuery)
    )
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map((option) => ({ name: option.label, value: option.value }));
}

export async function handleModelAutocomplete(
  services: ModelCommandServices,
  interaction: AutocompleteInteraction
): Promise<void> {
  try {
    const providers = await loadProviderCatalog(services);
    const focusedOption = interaction.options.getFocused(true);

    if (focusedOption.name === 'model') {
      await interaction.respond(
        createAutocompleteChoices(
          providers.providers.flatMap((provider) =>
            provider.models.map((model) => {
              const value = formatProviderModelValue({
                providerID: provider.id,
                modelID: model.id,
              });

              return {
                label: `${model.name} (${value})`,
                value,
              };
            })
          ),
          focusedOption.value
        )
      );
      return;
    }

    await interaction.respond([]);
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
      'Failed to process /model autocomplete'
    );

    if (!interaction.responded) {
      await interaction.respond([]);
    }
  }
}

async function setRequestedModel(
  services: ModelCommandServices,
  interaction: ChatInputCommandInteraction,
  requestedModel: { providerId: string; modelId: string }
): Promise<InteractionCommandResult> {
  const { thread } = assertBoundManagedSessionThread(services.threadSessionRepo, interaction);
  const providers = await loadProviderCatalog(services);
  const provider = findProvider(
    providers,
    requireOptionValue('provider', requestedModel.providerId)
  );
  const modelPreference = assertProviderModel(
    provider,
    requireOptionValue('model', requestedModel.modelId)
  );

  await services.threadTaskQueue.enqueue(thread.id, async () => {
    services.threadSessionRepo.setModel(thread.id, modelPreference);
  });

  return {
    embeds: [createModelSuccessEmbed(modelPreference, providers)],
  };
}

export async function handleModelCommand(
  services: ModelCommandServices,
  interaction: ChatInputCommandInteraction
): Promise<InteractionCommandResult> {
  try {
    const { thread } = assertBoundManagedSessionThread(services.threadSessionRepo, interaction);
    const requestedModel = resolveRequestedModel(interaction);

    if (requestedModel !== null) {
      return setRequestedModel(services, interaction, requestedModel);
    }

    const providers = await loadProviderCatalog(services);
    const currentModel = services.threadSessionRepo.findPromptPreferences(thread.id).model;

    return {
      embeds: [createModelViewEmbed(providers, currentModel)],
    };
  } catch (error) {
    if (error instanceof RuntimeError) {
      return {
        embeds: [createModelErrorEmbed(error.message)],
      };
    }

    logger.error(
      {
        err: toError(error),
        interactionId: interaction.id,
        commandName: interaction.commandName,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      },
      'Failed to process /model command'
    );

    return {
      embeds: [createModelErrorEmbed('Something went wrong while processing this command.')],
    };
  }
}
