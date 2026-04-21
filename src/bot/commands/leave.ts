import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';

import type { ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import type { InteractionCommandResult } from '../events/interactionCreate.js';
import { leaveGuildVoiceRuntime } from '../../voice/joinLeave.js';

const SUCCESS_EMBED_COLOR = 0x57f287;

export interface LeaveCommandServices {
  threadSessionRepo: ThreadSessionRepo;
}

export async function handleLeaveCommand(
  services: LeaveCommandServices,
  interaction: ChatInputCommandInteraction
): Promise<InteractionCommandResult> {
  const result = await leaveGuildVoiceRuntime(
    {
      threadSessionRepo: services.threadSessionRepo,
    },
    {
      context: interaction,
    }
  );

  const successEmbed = new EmbedBuilder()
    .setColor(SUCCESS_EMBED_COLOR)
    .setTitle('👋 Left Voice Channel')
    .setDescription('I stopped listening. Use `/join` when you want me back.');

  return {
    message: result.message,
    embeds: [successEmbed],
  };
}
