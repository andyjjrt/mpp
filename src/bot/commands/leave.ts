import type { ChatInputCommandInteraction } from 'discord.js';

import type { ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import {
  leaveGuildVoiceRuntime,
  type LeaveGuildVoiceRuntimeResult,
} from '../../voice/joinLeave.js';

export interface LeaveCommandServices {
  threadSessionRepo: ThreadSessionRepo;
}

export async function handleLeaveCommand(
  services: LeaveCommandServices,
  interaction: ChatInputCommandInteraction
): Promise<LeaveGuildVoiceRuntimeResult> {
  return leaveGuildVoiceRuntime(
    {
      threadSessionRepo: services.threadSessionRepo,
    },
    {
      context: interaction,
    }
  );
}
