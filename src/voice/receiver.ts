import { EndBehaviorType } from '@discordjs/voice';

import { RuntimeError, toError } from '../utils/errors.js';
import type { AudioReceiveStreamLike } from './transport.js';
import {
  DEFAULT_SEGMENT_MAX_UTTERANCE_MS,
  DEFAULT_SEGMENT_SILENCE_TIMEOUT_MS,
  createVoiceSegmenter,
  type VoiceSegment,
  type VoiceSegmenter,
} from './segmenter.js';
import { voiceRuntimes, type VoiceRuntimeRegistry, type VoiceRuntimeState } from './runtime.js';

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
  subscriptions: Map<string, AudioReceiveStreamLike>;
  speakingStartListener: (userId: string) => void;
  stopped: boolean;
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

export function startGuildVoiceReceiver(
  options: StartGuildVoiceReceiverOptions
): GuildVoiceReceiverController {
  const guildId = requireGuildId(options.guildId);
  const runtimes = options.runtimes ?? voiceRuntimes;
  const runtime = resolveRuntime(runtimes, guildId);

  if (activeReceivers.has(guildId) || runtime.recording.isActive) {
    throw new RuntimeError('Voice receive is already active for this guild.', 409);
  }

  const segmenter = createVoiceSegmenter({
    silenceTimeoutMs: options.silenceTimeoutMs ?? DEFAULT_SEGMENT_SILENCE_TIMEOUT_MS,
    maxUtteranceMs: options.maxUtteranceMs ?? DEFAULT_SEGMENT_MAX_UTTERANCE_MS,
    onSegment: (segment) => {
      options.onSegment({
        ...segment,
        guildId: runtime.guildId,
        threadId: runtime.threadId,
        sessionId: runtime.sessionId,
        voiceChannelId: runtime.voiceChannelId,
      });
    },
  });

  const subscriptions = new Map<string, AudioReceiveStreamLike>();

  function subscribeToSpeaker(speakerId: string): void {
    const normalizedSpeakerId = speakerId.trim();

    if (normalizedSpeakerId.length === 0 || subscriptions.has(normalizedSpeakerId)) {
      return;
    }

    try {
      const stream = runtime.connection.receiver.subscribe(normalizedSpeakerId, {
        end: {
          behavior: EndBehaviorType.Manual,
        },
      });

      subscriptions.set(normalizedSpeakerId, stream);

      stream.on('data', (chunk: Buffer) => {
        if (stream.destroyed || chunk.length === 0) {
          return;
        }

        segmenter.pushChunk({
          speakerId: normalizedSpeakerId,
          chunk,
        });
      });

      const cleanup = () => {
        subscriptions.delete(normalizedSpeakerId);
      };

      stream.once('close', cleanup);
      stream.once('end', cleanup);
      stream.once('error', (error) => {
        cleanup();
        options.onError?.(toError(error), {
          guildId,
          speakerId: normalizedSpeakerId,
          phase: 'stream',
        });
      });
    } catch (error) {
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
    stopped: false,
  };

  runtime.connection.receiver.speaking.on('start', activeReceiver.speakingStartListener);
  activeReceivers.set(guildId, activeReceiver);
  updateRecordingState(runtimes, guildId, true, options.onError);

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

  activeReceiver.stopped = true;
  activeReceivers.delete(normalizedGuildId);
  activeReceiver.runtime.connection.receiver.speaking.off(
    'start',
    activeReceiver.speakingStartListener
  );

  for (const stream of activeReceiver.subscriptions.values()) {
    destroySubscription(stream);
  }

  activeReceiver.subscriptions.clear();
  activeReceiver.segmenter.destroy();

  if (runtimes.getByGuildId(normalizedGuildId) !== null) {
    runtimes.updateRecordingState(normalizedGuildId, false);
  }
}

export function isGuildVoiceReceiverActive(guildId: string): boolean {
  const normalizedGuildId = requireGuildId(guildId);
  return activeReceivers.get(normalizedGuildId)?.stopped === false;
}
