import type { ChatInputCommandInteraction } from 'discord.js';

import type { AppConfig } from '../../types.js';
import type { OpencodeSdkContext } from '../../opencode/sdk.js';
import { handleVoiceSegment } from '../../pipeline/handleVoiceSegment.js';
import type { ThreadTaskQueue } from '../../pipeline/enqueue.js';
import type { ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import { RuntimeError, toError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import { startGuildVoiceReceiver } from '../../voice/receiver.js';
import { joinGuildVoiceRuntime, leaveGuildVoiceRuntime, type JoinGuildVoiceRuntimeResult } from '../../voice/joinLeave.js';

const logger = createLogger({ module: 'bot' });

export interface JoinCommandServices {
  config: AppConfig;
  opencodeContext: OpencodeSdkContext;
  threadSessionRepo: ThreadSessionRepo;
  threadTaskQueue: ThreadTaskQueue;
}

export async function handleJoinCommand(
  services: JoinCommandServices,
  interaction: ChatInputCommandInteraction,
): Promise<JoinGuildVoiceRuntimeResult> {
  const result = await joinGuildVoiceRuntime(
    {
      threadSessionRepo: services.threadSessionRepo,
    },
    {
      context: interaction,
      userId: interaction.user.id,
    },
  );

  try {
    startGuildVoiceReceiver({
      guildId: result.guildId,
      onSegment: (segment) => {
        void services.threadTaskQueue
          .enqueue(segment.threadId, async () => {
            const processedSegment = await handleVoiceSegment(
              {
                config: services.config,
                opencode: services.opencodeContext,
                threadSessionRepo: services.threadSessionRepo,
              },
              segment,
            );

            if (processedSegment === null) {
              logger.debug({ segmentChunkCount: segment.chunkCount, threadId: segment.threadId }, 'Discarded voice segment');
            }
          })
          .catch((error) => {
            logger.error({
              err: toError(error),
              threadId: segment.threadId,
              guildId: result.guildId,
              chunkCount: segment.chunkCount,
            },
            'Failed to enqueue or process voice segment',
            );
          });
      },
      onError: (error, context) => {
        logger.error(
          {
            err: toError(error),
            context,
            guildId: result.guildId,
            threadId: result.threadId,
          },
          'Voice receiver encountered an error',
        );
      },
    });
  } catch (error) {
    await leaveGuildVoiceRuntime({
      threadSessionRepo: services.threadSessionRepo,
    },
    {
      context: interaction,
    },
    );

    throw new RuntimeError(`Failed to start voice receiver: ${toError(error).message}`);
  }

  return result;
}
