import type { ChatInputCommandInteraction } from 'discord.js';

import type { ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import { joinGuildVoiceRuntime, type JoinGuildVoiceRuntimeResult } from '../../voice/joinLeave.js';

export interface JoinCommandServices {
  threadSessionRepo: ThreadSessionRepo;
}

export async function handleJoinCommand(
  services: JoinCommandServices,
  interaction: ChatInputCommandInteraction,
): Promise<JoinGuildVoiceRuntimeResult> {
  return joinGuildVoiceRuntime(
    {
      threadSessionRepo: services.threadSessionRepo,
    },
    {
      context: interaction,
      userId: interaction.user.id,
    },
  );
}
