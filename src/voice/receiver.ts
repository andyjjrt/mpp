import {
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice';
import { EventEmitter } from 'node:events';
import { opus as prismOpus } from 'prism-media';

import { RuntimeError, toError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import type { AudioReceiveStreamLike } from './transport.js';
import {
  DEFAULT_SEGMENT_MAX_UTTERANCE_MS,
  DEFAULT_SEGMENT_SILENCE_TIMEOUT_MS,
  createVoiceSegmenter,
  type VoiceSegment,
  type VoiceSegmenter,
} from './segmenter.js';
import { voiceRuntimes, type VoiceRuntimeRegistry, type VoiceRuntimeState } from './runtime.js';

const logger = createLogger({ module: 'voice:receiver' });

export const DISCORD_VOICE_PCM_SAMPLE_RATE_HZ = 48_000;
export const DISCORD_VOICE_PCM_CHANNELS = 2;
export const DISCORD_VOICE_OPUS_FRAME_SIZE = 960;

export interface VoiceReceiverSegment extends VoiceSegment {
  guildId: string;
  threadId: string;
  sessionId: string;
  voiceChannelId: string;
}

export interface StartGuildVoiceReceiverOptions {
  guildId: string;
  silenceTimeoutMs?: number;
  maxUtteranceMs?: number;
  onSegment: (segment: VoiceReceiverSegment) => void;
  onError?: (error: Error, context: VoiceReceiverErrorContext) => void;
  runtimes?: VoiceRuntimeRegistry;
}

export interface VoiceReceiverErrorContext {
  guildId: string;
  speakerId?: string;
  phase: 'subscribe' | 'stream' | 'recording_state';
}

export interface GuildVoiceReceiverController {
  guildId: string;
  isRecording(): boolean;
  stop(): void;
}

interface ActiveGuildVoiceReceiver {
  controller: GuildVoiceReceiverController;
  runtime: VoiceRuntimeState;
  segmenter: VoiceSegmenter;
  subscriptions: Map<string, SpeakerAudioPipeline>;
  speakingStartListener: (userId: string) => void;
  speakingEndListener: (userId: string) => void;
  stopped: boolean;
}

interface SpeakerAudioPipeline {
  stream: AudioReceiveStreamLike;
  decoder: prismOpus.Decoder;
}

const activeReceivers = new Map<string, ActiveGuildVoiceReceiver>();

function requireGuildId(guildId: string): string {
  const normalizedGuildId = guildId.trim();

  if (normalizedGuildId.length === 0) {
    throw new RuntimeError('guildId must be a non-empty string');
  }

  return normalizedGuildId;
}

function resolveRuntime(runtimes: VoiceRuntimeRegistry, guildId: string): VoiceRuntimeState {
  const runtime = runtimes.getByGuildId(guildId);

  if (runtime === null) {
    throw new RuntimeError(`No active voice runtime exists for guild "${guildId}".`, 404);
  }

  return runtime;
}

function updateRecordingState(
  runtimes: VoiceRuntimeRegistry,
  guildId: string,
  isRecording: boolean,
  onError?: StartGuildVoiceReceiverOptions['onError']
): void {
  try {
    runtimes.updateRecordingState(guildId, isRecording);
  } catch (error) {
    onError?.(toError(error), {
      guildId,
      phase: 'recording_state',
    });

    throw error;
  }
}

function destroySubscription(stream: AudioReceiveStreamLike): void {
  if (!stream.destroyed) {
    stream.destroy();
  }
}

export async function startGuildVoiceReceiver(
  options: StartGuildVoiceReceiverOptions
): Promise<GuildVoiceReceiverController> {
  const guildId = requireGuildId(options.guildId);
  const runtimes = options.runtimes ?? voiceRuntimes;
  const runtime = resolveRuntime(runtimes, guildId);

  logger.debug({ guildId }, 'Starting voice receiver');

  if (activeReceivers.has(guildId) || runtime.recording.isActive) {
    throw new RuntimeError('Voice receive is already active for this guild.', 409);
  }

  // Wait for connection to be ready before setting up listeners
  try {
    logger.debug({ guildId }, 'Waiting for voice connection to be ready...');
    await entersState(runtime.connection as VoiceConnection, VoiceConnectionStatus.Ready, 30_000);
    logger.debug({ guildId }, 'Voice connection is ready');
  } catch (error) {
    logger.error({ err: toError(error), guildId }, 'Voice connection failed to become ready');
    throw new RuntimeError('Voice connection failed to become ready');
  }

  const segmenter = createVoiceSegmenter({
    silenceTimeoutMs: options.silenceTimeoutMs ?? DEFAULT_SEGMENT_SILENCE_TIMEOUT_MS,
    maxUtteranceMs: options.maxUtteranceMs ?? DEFAULT_SEGMENT_MAX_UTTERANCE_MS,
    onSegment: (segment) => {
      logger.debug(
        {
          userId: segment.userId,
          chunkCount: segment.chunkCount,
          audioBytes: segment.audio.byteLength,
          flushReason: segment.flushReason,
        },
        'Voice segment created'
      );
      options.onSegment({
        ...segment,
        guildId: runtime.guildId,
        threadId: runtime.threadId,
        sessionId: runtime.sessionId,
        voiceChannelId: runtime.voiceChannelId,
      });
    },
  });

  const subscriptions = new Map<string, SpeakerAudioPipeline>();

  function subscribeToSpeaker(speakerId: string): void {
    const normalizedSpeakerId = speakerId.trim();

    logger.debug({ speakerId: normalizedSpeakerId }, 'Speaking started, subscribing to speaker');

    if (normalizedSpeakerId.length === 0 || subscriptions.has(normalizedSpeakerId)) {
      logger.debug(
        {
          speakerId: normalizedSpeakerId,
          alreadySubscribed: subscriptions.has(normalizedSpeakerId),
        },
        'Skipping speaker subscription'
      );
      return;
    }

    try {
      const stream = runtime.connection.receiver.subscribe(normalizedSpeakerId, {
        end: {
          behavior: EndBehaviorType.Manual,
        },
      });
      const decoder = new prismOpus.Decoder({
        rate: DISCORD_VOICE_PCM_SAMPLE_RATE_HZ,
        channels: DISCORD_VOICE_PCM_CHANNELS,
        frameSize: DISCORD_VOICE_OPUS_FRAME_SIZE,
      });

      subscriptions.set(normalizedSpeakerId, { stream, decoder });
      logger.debug({ speakerId: normalizedSpeakerId }, 'Subscribed to speaker audio stream');

      decoder.on('data', (chunk: Buffer) => {
        if (stream.destroyed || chunk.length === 0) {
          return;
        }

        logger.trace(
          { speakerId: normalizedSpeakerId, chunkSize: chunk.length },
          'Received decoded PCM chunk'
        );

        segmenter.pushChunk({
          speakerId: normalizedSpeakerId,
          chunk,
        });
      });

      decoder.once('error', (error) => {
        destroySubscription(stream);
        logger.error(
          { err: toError(error), speakerId: normalizedSpeakerId },
          'Speaker decoder error'
        );
        options.onError?.(toError(error), {
          guildId,
          speakerId: normalizedSpeakerId,
          phase: 'stream',
        });
      });

      stream.on('data', (chunk: Buffer) => {
        if (stream.destroyed || chunk.length === 0) {
          return;
        }

        logger.trace(
          { speakerId: normalizedSpeakerId, chunkSize: chunk.length },
          'Received Opus audio chunk'
        );
        decoder.write(chunk);
      });

      const cleanup = () => {
        subscriptions.delete(normalizedSpeakerId);
        decoder.destroy();
        logger.debug({ speakerId: normalizedSpeakerId }, 'Speaker stream cleaned up');
      };

      stream.once('close', cleanup);
      stream.once('end', cleanup);
      stream.once('error', (error) => {
        cleanup();
        logger.error(
          { err: toError(error), speakerId: normalizedSpeakerId },
          'Speaker stream error'
        );
        options.onError?.(toError(error), {
          guildId,
          speakerId: normalizedSpeakerId,
          phase: 'stream',
        });
      });
    } catch (error) {
      logger.error(
        { err: toError(error), speakerId: normalizedSpeakerId },
        'Failed to subscribe to speaker'
      );
      options.onError?.(toError(error), {
        guildId,
        speakerId: normalizedSpeakerId,
        phase: 'subscribe',
      });

      throw error;
    }
  }

  const activeReceiver: ActiveGuildVoiceReceiver = {
    controller: {
      guildId,
      isRecording: () => !activeReceiver.stopped,
      stop: () => stopGuildVoiceReceiver(guildId, runtimes),
    },
    runtime,
    segmenter,
    subscriptions,
    speakingStartListener: subscribeToSpeaker,
    speakingEndListener: (userId) => {
      logger.debug({ userId }, 'Speaking ended');
      segmenter.markSpeakerInactive({ userId });
    },
    stopped: false,
  };

  runtime.connection.receiver.speaking.on('start', activeReceiver.speakingStartListener);
  (runtime.connection.receiver.speaking as EventEmitter).on(
    'end',
    activeReceiver.speakingEndListener
  );
  activeReceivers.set(guildId, activeReceiver);
  updateRecordingState(runtimes, guildId, true, options.onError);

  logger.info({ guildId }, 'Voice receiver started');

  return activeReceiver.controller;
}

export function stopGuildVoiceReceiver(
  guildId: string,
  runtimes: VoiceRuntimeRegistry = voiceRuntimes
): void {
  const normalizedGuildId = requireGuildId(guildId);
  const activeReceiver = activeReceivers.get(normalizedGuildId);

  if (activeReceiver === undefined || activeReceiver.stopped) {
    return;
  }

  logger.info({ guildId: normalizedGuildId }, 'Stopping voice receiver');

  activeReceiver.stopped = true;
  activeReceivers.delete(normalizedGuildId);
  activeReceiver.runtime.connection.receiver.speaking.off(
    'start',
    activeReceiver.speakingStartListener
  );
  (activeReceiver.runtime.connection.receiver.speaking as EventEmitter).off(
    'end',
    activeReceiver.speakingEndListener
  );

  for (const { stream, decoder } of activeReceiver.subscriptions.values()) {
    decoder.destroy();
    destroySubscription(stream);
  }

  activeReceiver.subscriptions.clear();
  activeReceiver.segmenter.destroy();

  if (runtimes.getByGuildId(normalizedGuildId) !== null) {
    runtimes.updateRecordingState(normalizedGuildId, false);
  }

  logger.info({ guildId: normalizedGuildId }, 'Voice receiver stopped');
}

export function isGuildVoiceReceiverActive(guildId: string): boolean {
  const normalizedGuildId = requireGuildId(guildId);
  return activeReceivers.get(normalizedGuildId)?.stopped === false;
}
