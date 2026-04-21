import { REST, Routes, SlashCommandBuilder } from 'discord.js';

import { loadConfig } from './config';
import { ConfigValidationError, toError } from './utils/errors';
import { createLogger, setLoggerLevel } from './utils/logger';

const logger = createLogger({ module: 'register-commands' });

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Ask the bot to join your current voice channel.'),
  new SlashCommandBuilder().setName('leave').setDescription('Ask the bot to leave its current voice channel.'),
].map((command) => command.toJSON());

function resolveGuildId(guildId: string | undefined): string {
  if (guildId === undefined) {
    throw new ConfigValidationError(['DISCORD_GUILD_ID: required for slash-command registration']);
  }

  return guildId;
}

export async function registerCommands(): Promise<void> {
  const config = loadConfig();

  setLoggerLevel(config.logLevel);

  const guildId = resolveGuildId(config.discord.guildId);
  const rest = new REST({ version: '10' }).setToken(config.discord.botToken);

  logger.info(
    {
      applicationId: config.discord.clientId,
      guildId,
      commandNames: commands.map(({ name }) => name),
      gatewayIntentNames: config.discord.requirements.capabilityRequirements.slashCommands.gatewayIntentNames,
      permissionFlagNames: config.discord.requirements.capabilityRequirements.slashCommands.permissionFlagNames,
    },
    'Registering Discord slash commands',
  );

  await rest.put(Routes.applicationGuildCommands(config.discord.clientId, guildId), { body: commands });

  logger.info(
    {
      applicationId: config.discord.clientId,
      guildId,
      registeredCommandCount: commands.length,
    },
    'Discord slash commands registered',
  );
}

async function main(): Promise<void> {
  try {
    await registerCommands();
  } catch (error) {
    logger.fatal({ err: toError(error) }, 'Slash-command registration failed');
    process.exitCode = 1;
  }
}

void main();
