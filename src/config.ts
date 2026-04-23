import dotenv from 'dotenv';
import { GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';

import type {
  AppConfig,
  DiscordCapabilityRequirementsMap,
  DiscordGatewayIntentName,
  DiscordPartialName,
  DiscordPermissionFlagName,
  LogLevel,
  NodeEnvironment,
} from './types.js';
import { ConfigValidationError } from './utils/errors.js';

const NODE_ENVIRONMENTS = [
  'development',
  'test',
  'production',
] as const satisfies readonly NodeEnvironment[];
const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const satisfies readonly LogLevel[];

export const DISCORD_CAPABILITY_REQUIREMENTS = {
  mentions: {
    gatewayIntentNames: ['Guilds', 'GuildMessages', 'MessageContent'],
    permissionFlagNames: ['ViewChannel', 'ReadMessageHistory', 'SendMessages'],
  },
  threads: {
    gatewayIntentNames: ['Guilds', 'GuildMessages', 'MessageContent'],
    permissionFlagNames: [
      'ViewChannel',
      'ReadMessageHistory',
      'CreatePublicThreads',
      'SendMessagesInThreads',
    ],
  },
  slashCommands: {
    gatewayIntentNames: ['Guilds'],
    permissionFlagNames: ['ViewChannel', 'UseApplicationCommands'],
  },
  voice: {
    gatewayIntentNames: ['Guilds', 'GuildVoiceStates'],
    permissionFlagNames: ['ViewChannel', 'Connect', 'Speak'],
  },
} as const satisfies DiscordCapabilityRequirementsMap;

export const DISCORD_REQUIRED_PARTIAL_NAMES = [
  'Channel',
] as const satisfies readonly DiscordPartialName[];

function uniqueValues<Value>(values: readonly Value[]): readonly Value[] {
  return [...new Set(values)];
}

function resolveGatewayIntent(name: DiscordGatewayIntentName): GatewayIntentBits {
  return GatewayIntentBits[name] as GatewayIntentBits;
}

function resolvePartial(name: DiscordPartialName): Partials {
  return Partials[name] as Partials;
}

function resolvePermissionFlag(name: DiscordPermissionFlagName): bigint {
  return PermissionFlagsBits[name] as bigint;
}

export const DISCORD_REQUIRED_GATEWAY_INTENT_NAMES = uniqueValues(
  Object.values(DISCORD_CAPABILITY_REQUIREMENTS).flatMap(
    ({ gatewayIntentNames }) => gatewayIntentNames
  )
) as readonly DiscordGatewayIntentName[];

export const DISCORD_REQUIRED_PERMISSION_FLAG_NAMES = uniqueValues(
  Object.values(DISCORD_CAPABILITY_REQUIREMENTS).flatMap(
    ({ permissionFlagNames }) => permissionFlagNames
  )
) as readonly DiscordPermissionFlagName[];

export const DISCORD_REQUIRED_GATEWAY_INTENTS =
  DISCORD_REQUIRED_GATEWAY_INTENT_NAMES.map(resolveGatewayIntent);
export const DISCORD_REQUIRED_PARTIALS = DISCORD_REQUIRED_PARTIAL_NAMES.map(resolvePartial);
export const DISCORD_REQUIRED_PERMISSION_FLAGS =
  DISCORD_REQUIRED_PERMISSION_FLAG_NAMES.map(resolvePermissionFlag);

const environmentSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().trim().min(1, 'DISCORD_BOT_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().trim().min(1, 'DISCORD_CLIENT_ID is required'),
  DISCORD_MONITORED_CHANNEL_ID: z
    .string()
    .trim()
    .min(1, 'DISCORD_MONITORED_CHANNEL_ID is required'),
  DISCORD_GUILD_ID: z.string().trim().min(1, 'DISCORD_GUILD_ID cannot be empty').optional(),
  OPENCODE_API_KEY: z.string().trim().min(1, 'OPENCODE_API_KEY cannot be empty').optional(),
  OPENCODE_BASE_URL: z
    .string()
    .trim()
    .url('OPENCODE_BASE_URL must be a valid URL')
    .default('https://api.opencode.ai'),
  OPENCODE_DIRECTORY: z.string().trim().min(1, 'OPENCODE_DIRECTORY cannot be empty').optional(),
  OPENCODE_SERVER_USERNAME: z.string().trim().default('opencode'),
  OPENCODE_SERVER_PASSWORD: z.string().trim().optional(),
  ASR_API_KEY: z.string().trim().min(1, 'ASR_API_KEY cannot be empty').optional(),
  ASR_BASE_URL: z.string().trim().url('ASR_BASE_URL must be a valid URL').optional(),
  ASR_MODEL: z.string().trim().min(1, 'ASR_MODEL cannot be empty').optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  NODE_ENV: z.enum(NODE_ENVIRONMENTS).default('development'),
  ENABLE_COMPLETION_MENTION: z.preprocess(
    (val) => (typeof val === 'string' ? val.toLowerCase() === 'true' : Boolean(val)),
    z.boolean().default(false)
  ),
  ENABLE_COMPLETION_REPORT: z.preprocess(
    (val) => (typeof val === 'string' ? val.toLowerCase() === 'true' : Boolean(val)),
    z.boolean().default(false)
  ),
});

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const key = issue.path.join('.') || 'environment';
    return `${key}: ${issue.message}`;
  });
}

export function loadConfig(): AppConfig {
  dotenv.config();

  const result = environmentSchema.safeParse(process.env);

  if (!result.success) {
    throw new ConfigValidationError(formatIssues(result.error));
  }

  const env = result.data;

  return {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    enableCompletionMention: env.ENABLE_COMPLETION_MENTION,
    enableCompletionReport: env.ENABLE_COMPLETION_REPORT,
    discord: {
      botToken: env.DISCORD_BOT_TOKEN,
      clientId: env.DISCORD_CLIENT_ID,
      monitoredChannelId: env.DISCORD_MONITORED_CHANNEL_ID,
      guildId: env.DISCORD_GUILD_ID,
      requirements: {
        capabilityRequirements: DISCORD_CAPABILITY_REQUIREMENTS,
        gatewayIntentNames: DISCORD_REQUIRED_GATEWAY_INTENT_NAMES,
        gatewayIntents: DISCORD_REQUIRED_GATEWAY_INTENTS,
        partialNames: DISCORD_REQUIRED_PARTIAL_NAMES,
        partials: DISCORD_REQUIRED_PARTIALS,
        permissionFlagNames: DISCORD_REQUIRED_PERMISSION_FLAG_NAMES,
        permissionFlags: DISCORD_REQUIRED_PERMISSION_FLAGS,
      },
    },
    opencode: {
      apiKey: env.OPENCODE_API_KEY,
      baseUrl: env.OPENCODE_BASE_URL,
      directory: env.OPENCODE_DIRECTORY,
      username: env.OPENCODE_SERVER_USERNAME,
      password: env.OPENCODE_SERVER_PASSWORD,
    },
    asr: {
      apiKey: env.ASR_API_KEY,
      baseUrl: env.ASR_BASE_URL,
      model: env.ASR_MODEL,
    },
  };
}
