import type { AnyThreadChannel, Guild } from 'discord.js';

import type { AppConfig } from '../types.js';
import { handleThreadMessage, type HandleThreadMessageResult } from './handleThreadMessage.js';
import type { OpencodeSdkContext } from '../opencode/sdk.js';
import { DEFAULT_NORMALIZED_SAMPLE_RATE, normalizePcmToWav } from '../voice/normalizer.js';
import type { VoiceReceiverSegment } from '../voice/receiver.js';
import { guildVoiceRuntimes } from '../voice/runtime.js';
import { RuntimeError, toError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { isAsrTranscriptionError, transcribeWav } from '../asr/transcribe.js';
import type { ThreadSessionRepo } from '../storage/threadSessionRepo.js';

const logger = createLogger({ module: 'pipeline' });

const DEFAULT_VOICE_SEGMENT_SAMPLE_RATE_HZ = 48_000;

export interface HandleVoiceSegmentDependencies {
  config: AppConfig;
  opencode: OpencodeSdkContext;
  threadSessionRepo: ThreadSessionRepo;
  sourceSampleRateHz?: number;
}

export interface HandleVoiceSegmentResult extends HandleThreadMessageResult {
  transcript: string;
  displayName: string;
  segment: VoiceReceiverSegment;
}

async function resolveDisplayName(guild: Guild, userId: string): Promise<string> {
  const normalizedUserId = userId.trim();

  if (normalizedUserId.length === 0) {
    return '<unknown>';
  }

  return guild.members
    .fetch(normalizedUserId)
    .then((member) => member.displayName.trim() || member.user.username)
    .catch(() => normalizedUserId);
}

async function getThreadFromSegment(segment: VoiceReceiverSegment): Promise<AnyThreadChannel> {
  const runtime = guildVoiceRuntimes.get(segment.guildId);

  if (runtime === null) {
    throw new RuntimeError(`No active voice runtime exists for guild "${segment.guildId}".`);
  }

  if (runtime.threadId === segment.threadId) {
    return runtime.thread;
  }

  try {
    const runtimeThread = await runtime.guild.channels.fetch(segment.threadId);

    if (runtimeThread !== null && runtimeThread.isThread()) {
      return runtimeThread;
    }

    throw new RuntimeError(`Thread runtime channel ${segment.threadId} is missing for guild ${segment.guildId}`);
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }

    throw new RuntimeError(`Failed to resolve runtime thread ${segment.threadId}: ${toError(error).message}`);
  }
}

export async function handleVoiceSegment(
  dependencies: HandleVoiceSegmentDependencies,
  segment: VoiceReceiverSegment,
): Promise<HandleVoiceSegmentResult | null> {
  const sourceSampleRateHz = dependencies.sourceSampleRateHz ?? DEFAULT_VOICE_SEGMENT_SAMPLE_RATE_HZ;
  const runtime = guildVoiceRuntimes.get(segment.guildId);

  if (runtime === null) {
    throw new RuntimeError(`No active voice runtime exists for guild ${segment.guildId}`);
  }

  const displayName = await resolveDisplayName(runtime.guild, segment.userId);

  let normalizedAudio;
  try {
    normalizedAudio = normalizePcmToWav({
      pcm: segment.audio,
      sampleRate: sourceSampleRateHz,
      targetSampleRate: DEFAULT_NORMALIZED_SAMPLE_RATE,
    });
  } catch (error) {
    logger.warn(
      {
        err: toError(error),
        guildId: segment.guildId,
        userId: segment.userId,
        threadId: segment.threadId,
        chunkCount: segment.chunkCount,
      },
      'Failed to normalize voice segment audio to WAV',
    );
    return null;
  }

  let transcript: string;
  try {
    const transcriptResult = await transcribeWav(normalizedAudio.buffer, undefined, {
      asr: dependencies.config.asr,
    });
    transcript = transcriptResult.text.trim();
  } catch (error) {
    const asrError = isAsrTranscriptionError(error) ? error : null;
    logger.info(
      {
        guildId: segment.guildId,
        threadId: segment.threadId,
        userId: segment.userId,
        code: asrError?.code,
        errorCode: asrError?.code,
        message: asrError?.message ?? toError(error).message,
      },
      'Discarding voice segment due ASR failure',
    );
    return null;
  }

  if (transcript.length === 0) {
    logger.info(
      {
        guildId: segment.guildId,
        threadId: segment.threadId,
        userId: segment.userId,
      },
      'Discarding voice segment due empty transcript',
    );
    return null;
  }

  const promptText = `${displayName}: ${transcript}`;
  const thread = await getThreadFromSegment(segment);

  const promptResult = await handleThreadMessage(
    {
      opencode: dependencies.opencode,
      threadSessionRepo: dependencies.threadSessionRepo,
    },
    {
      thread,
      text: promptText,
    },
  );

  return {
    ...promptResult,
    transcript,
    displayName,
    segment,
  };
}
