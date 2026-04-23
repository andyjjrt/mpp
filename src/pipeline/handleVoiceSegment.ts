import { EmbedBuilder, type AnyThreadChannel, type Guild } from 'discord.js';

import type { AppConfig } from '../types.js';
import { sendEmbedRepliesToThread } from '../discord/replies.js';
import { handleThreadMessage, type HandleThreadMessageResult } from './handleThreadMessage.js';
import type { OpencodeSdkContext } from '../opencode/sdk.js';
import { DEFAULT_NORMALIZED_SAMPLE_RATE, normalizePcmToWav } from '../voice/normalizer.js';
import {
  DISCORD_VOICE_PCM_CHANNELS,
  DISCORD_VOICE_PCM_SAMPLE_RATE_HZ,
  type VoiceReceiverSegment,
} from '../voice/receiver.js';
import { guildVoiceRuntimes } from '../voice/runtime.js';
import { RuntimeError, toError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { isAsrTranscriptionError, transcribeWav } from '../asr/transcribe.js';
import type { ThreadSessionRepo } from '../storage/threadSessionRepo.js';

const logger = createLogger({ module: 'pipeline' });
const TRANSCRIPT_EMBED_COLOR = 0x5865f2;
const TRANSCRIPT_EMBED_DESCRIPTION_LIMIT = 4_096;

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

    throw new RuntimeError(
      `Thread runtime channel ${segment.threadId} is missing for guild ${segment.guildId}`
    );
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }

    throw new RuntimeError(
      `Failed to resolve runtime thread ${segment.threadId}: ${toError(error).message}`
    );
  }
}

function createTranscriptEmbeds(displayName: string, transcript: string): EmbedBuilder[] {
  const content = `${displayName}: ${transcript}`.trim();
  const chunks: string[] = [];

  for (let start = 0; start < content.length; start += TRANSCRIPT_EMBED_DESCRIPTION_LIMIT) {
    chunks.push(content.slice(start, start + TRANSCRIPT_EMBED_DESCRIPTION_LIMIT));
  }

  return chunks.map((chunk, index) =>
    new EmbedBuilder()
      .setColor(TRANSCRIPT_EMBED_COLOR)
      .setTitle(index === 0 ? 'Voice Transcript' : 'Voice Transcript (cont.)')
      .setDescription(chunk)
  );
}

export async function handleVoiceSegment(
  dependencies: HandleVoiceSegmentDependencies,
  segment: VoiceReceiverSegment
): Promise<HandleVoiceSegmentResult | null> {
  logger.debug(
    {
      userId: segment.userId,
      guildId: segment.guildId,
      chunkCount: segment.chunkCount,
      audioBytes: segment.audio.byteLength,
      flushReason: segment.flushReason,
    },
    'Handling voice segment'
  );
  const sourceSampleRateHz = dependencies.sourceSampleRateHz ?? DISCORD_VOICE_PCM_SAMPLE_RATE_HZ;
  const runtime = guildVoiceRuntimes.get(segment.guildId);

  if (runtime === null) {
    throw new RuntimeError(`No active voice runtime exists for guild ${segment.guildId}`);
  }

  // Only allow voice from the thread creator (first user)
  const firstUserId = dependencies.threadSessionRepo.findFirstUserId(segment.threadId);
  if (firstUserId !== null && firstUserId !== segment.userId) {
    logger.debug(
      {
        userId: segment.userId,
        firstUserId,
        threadId: segment.threadId,
      },
      'Voice input rejected: user is not the thread creator'
    );
    return null;
  }

  const displayName = await resolveDisplayName(runtime.guild, segment.userId);

  let normalizedAudio;
  try {
    normalizedAudio = normalizePcmToWav({
      pcm: segment.audio,
      sampleRate: sourceSampleRateHz,
      channels: DISCORD_VOICE_PCM_CHANNELS,
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
      'Failed to normalize voice segment audio to WAV'
    );
    return null;
  }

  let transcript: string;
  try {
    logger.debug({ audioBytes: normalizedAudio.buffer.byteLength }, 'Starting ASR transcription');
    const transcriptResult = await transcribeWav(normalizedAudio.buffer, undefined, {
      asr: dependencies.config.asr,
    });
    transcript = transcriptResult.text.trim();
    logger.debug({ transcriptLength: transcript.length }, 'ASR transcription completed');
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
      'Discarding voice segment due ASR failure'
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
      'Discarding voice segment due empty transcript'
    );
    return null;
  }

  const promptText = `${displayName}: ${transcript}`;
  const thread = await getThreadFromSegment(segment);
  await sendEmbedRepliesToThread(thread, createTranscriptEmbeds(displayName, transcript));

  const promptResult = await handleThreadMessage(
    {
      opencode: dependencies.opencode,
      threadSessionRepo: dependencies.threadSessionRepo,
      enableCompletionMention: dependencies.config.enableCompletionMention,
      enableCompletionReport: dependencies.config.enableCompletionReport,
    },
    {
      thread,
      text: promptText,
    }
  );

  logger.debug({ transcript, displayName }, 'Voice message processed successfully');

  return {
    ...promptResult,
    transcript,
    displayName,
    segment,
  };
}
