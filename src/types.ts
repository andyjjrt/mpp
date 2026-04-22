import { GatewayIntentBits, Partials } from 'discord.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type NodeEnvironment = 'development' | 'test' | 'production';

export type DiscordCapabilityName = 'mentions' | 'threads' | 'slashCommands' | 'voice';
export type DiscordGatewayIntentName =
  | 'Guilds'
  | 'GuildMessages'
  | 'MessageContent'
  | 'GuildVoiceStates';
export type DiscordPartialName = 'Channel';
export type DiscordPermissionFlagName =
  | 'ViewChannel'
  | 'ReadMessageHistory'
  | 'SendMessages'
  | 'CreatePublicThreads'
  | 'SendMessagesInThreads'
  | 'UseApplicationCommands'
  | 'Connect'
  | 'Speak';

export interface DiscordCapabilityRequirements {
  gatewayIntentNames: readonly DiscordGatewayIntentName[];
  permissionFlagNames: readonly DiscordPermissionFlagName[];
}

export type DiscordCapabilityRequirementsMap = Record<
  DiscordCapabilityName,
  DiscordCapabilityRequirements
>;

export interface DiscordRequirements {
  capabilityRequirements: DiscordCapabilityRequirementsMap;
  gatewayIntentNames: readonly DiscordGatewayIntentName[];
  gatewayIntents: readonly GatewayIntentBits[];
  partialNames: readonly DiscordPartialName[];
  partials: readonly Partials[];
  permissionFlagNames: readonly DiscordPermissionFlagName[];
  permissionFlags: readonly bigint[];
}

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  logLevel: LogLevel;
  discord: {
    botToken: string;
    clientId: string;
    monitoredChannelId: string;
    guildId?: string;
    requirements: DiscordRequirements;
  };
  opencode: {
    apiKey?: string;
    baseUrl: string;
    directory?: string;
    username?: string;
    password?: string;
  };
  asr: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
}
