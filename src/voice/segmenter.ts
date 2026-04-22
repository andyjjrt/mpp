import { RuntimeError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

export type VoiceSegmentFlushReason = 'silence_timeout' | 'max_utterance' | 'manual';

export const DEFAULT_SEGMENT_SILENCE_TIMEOUT_MS = 1_000;
export const DEFAULT_SEGMENT_MAX_UTTERANCE_MS = 15_000;

export interface SpeakerBufferState {
  userId: string;
  chunks: Buffer[];
  speaking: boolean;
  lastVoiceAt: number;
  startedAt: number;
}

export interface VoiceSegment {
  userId: string;
  audio: Buffer;
  chunkCount: number;
  startedAt: number;
  lastVoiceAt: number;
  flushedAt: number;
  flushReason: VoiceSegmentFlushReason;
}

export interface CreateVoiceSegmenterOptions {
  silenceTimeoutMs?: number;
  maxUtteranceMs?: number;
  now?: () => number;
  onSegment?: (segment: VoiceSegment) => void;
}

export interface SpeakerActivityInput {
  userId: string;
  atMs?: number;
}

export interface AppendSpeakerChunkInput extends SpeakerActivityInput {
  chunk: Uint8Array;
}

export interface PushSpeakerChunkInput {
  speakerId: string;
  chunk: Uint8Array;
  atMs?: number;
}

export interface FlushSpeakerInput extends SpeakerActivityInput {
  reason?: VoiceSegmentFlushReason;
}

export interface FlushAllSpeakersInput {
  atMs?: number;
  reason?: VoiceSegmentFlushReason;
}

export interface VoiceSegmenter {
  getSpeaker(userId: string): SpeakerBufferState | null;
  markSpeakerActive(input: SpeakerActivityInput): SpeakerBufferState;
  markSpeakerInactive(input: SpeakerActivityInput): SpeakerBufferState | null;
  appendChunk(input: AppendSpeakerChunkInput): VoiceSegment[];
  pushChunk(input: PushSpeakerChunkInput): VoiceSegment[];
  flushSpeaker(input: FlushSpeakerInput): VoiceSegment | null;
  flushAll(input?: FlushAllSpeakersInput): VoiceSegment[];
  flushExpired(atMs?: number): VoiceSegment[];
  destroy(): VoiceSegment[];
  entries(): IterableIterator<[string, SpeakerBufferState]>;
}

type SpeakerTimeout = ReturnType<typeof setTimeout>;

function requireUserId(userId: string): string {
  const normalizedUserId = userId.trim();

  if (normalizedUserId.length === 0) {
    throw new RuntimeError('userId must be a non-empty string');
  }

  return normalizedUserId;
}

function requireDuration(name: 'silenceTimeoutMs' | 'maxUtteranceMs', value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuntimeError(`${name} must be a positive number`);
  }

  return value;
}

function requireTimestamp(name: 'atMs' | 'flushedAt', value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RuntimeError(`${name} must be a non-negative number`);
  }

  return value;
}

function resolveTimestamp(atMs: number | undefined, now: () => number): number {
  return requireTimestamp('atMs', atMs ?? now());
}

function normalizeChunk(chunk: Uint8Array): Buffer {
  if (!(chunk instanceof Uint8Array)) {
    throw new RuntimeError('chunk must be a Uint8Array or Buffer');
  }

  const normalizedChunk = Buffer.from(chunk);

  if (normalizedChunk.byteLength === 0) {
    throw new RuntimeError('chunk must not be empty');
  }

  return normalizedChunk;
}

function requireFlushReason(reason: VoiceSegmentFlushReason | undefined): VoiceSegmentFlushReason {
  if (reason === undefined) {
    return 'manual';
  }

  if (reason === 'silence_timeout' || reason === 'max_utterance' || reason === 'manual') {
    return reason;
  }

  throw new RuntimeError('flush reason is invalid');
}

function cloneState(state: SpeakerBufferState): SpeakerBufferState {
  return {
    userId: state.userId,
    chunks: state.chunks.map((chunk) => Buffer.from(chunk)),
    speaking: state.speaking,
    lastVoiceAt: state.lastVoiceAt,
    startedAt: state.startedAt,
  };
}

function createSpeakerState(userId: string, atMs: number): SpeakerBufferState {
  return {
    userId,
    chunks: [],
    speaking: true,
    lastVoiceAt: atMs,
    startedAt: atMs,
  };
}

function shouldFlushForSilence(
  state: SpeakerBufferState,
  atMs: number,
  silenceTimeoutMs: number
): boolean {
  return atMs - state.lastVoiceAt >= silenceTimeoutMs;
}

function shouldFlushForMaxUtterance(
  state: SpeakerBufferState,
  atMs: number,
  maxUtteranceMs: number
): boolean {
  return atMs - state.startedAt >= maxUtteranceMs;
}

function flushStoredSpeaker(
  speakers: Map<string, SpeakerBufferState>,
  userId: string,
  flushedAt: number,
  reason: VoiceSegmentFlushReason
): VoiceSegment | null {
  const state = speakers.get(userId);

  if (state === undefined) {
    return null;
  }

  speakers.delete(userId);

  if (state.chunks.length === 0) {
    return null;
  }

  const audio = Buffer.concat(state.chunks);

  if (audio.byteLength === 0) {
    return null;
  }

  return {
    userId: state.userId,
    audio,
    chunkCount: state.chunks.length,
    startedAt: state.startedAt,
    lastVoiceAt: state.lastVoiceAt,
    flushedAt: requireTimestamp('flushedAt', flushedAt),
    flushReason: reason,
  };
}

export function createVoiceSegmenter(options: CreateVoiceSegmenterOptions): VoiceSegmenter {
  const logger = createLogger({ module: 'voice:segmenter' });
  const silenceTimeoutMs = requireDuration(
    'silenceTimeoutMs',
    options.silenceTimeoutMs ?? DEFAULT_SEGMENT_SILENCE_TIMEOUT_MS
  );
  const maxUtteranceMs = requireDuration(
    'maxUtteranceMs',
    options.maxUtteranceMs ?? DEFAULT_SEGMENT_MAX_UTTERANCE_MS
  );
  const now = options.now ?? Date.now;
  const onSegment = options.onSegment;
  const speakers = new Map<string, SpeakerBufferState>();
  const silenceTimeouts = new Map<string, SpeakerTimeout>();
  const maxUtteranceTimeouts = new Map<string, SpeakerTimeout>();

  function emitSegments(segments: readonly VoiceSegment[]): void {
    if (onSegment === undefined) {
      return;
    }

    for (const segment of segments) {
      onSegment(segment);
    }
  }

  function emitOptionalSegment(segment: VoiceSegment | null): VoiceSegment | null {
    if (segment !== null) {
      emitSegments([segment]);
    }

    return segment;
  }

  function clearSpeakerTimeouts(userId: string): void {
    const silenceTimeout = silenceTimeouts.get(userId);

    if (silenceTimeout !== undefined) {
      clearTimeout(silenceTimeout);
      silenceTimeouts.delete(userId);
    }

    const maxUtteranceTimeout = maxUtteranceTimeouts.get(userId);

    if (maxUtteranceTimeout !== undefined) {
      clearTimeout(maxUtteranceTimeout);
      maxUtteranceTimeouts.delete(userId);
    }
  }

  function flushSingleSpeaker(
    userId: string,
    atMs: number,
    reason: VoiceSegmentFlushReason
  ): VoiceSegment | null {
    clearSpeakerTimeouts(userId);
    return flushStoredSpeaker(speakers, userId, atMs, reason);
  }

  function scheduleSilenceFlush(userId: string): void {
    const existingTimeout = silenceTimeouts.get(userId);

    if (existingTimeout !== undefined) {
      clearTimeout(existingTimeout);
    }

    const timeout = setTimeout(() => {
      silenceTimeouts.delete(userId);
      emitOptionalSegment(flushSingleSpeaker(userId, now(), 'silence_timeout'));
    }, silenceTimeoutMs);

    silenceTimeouts.set(userId, timeout);
  }

  function scheduleMaxUtteranceFlush(userId: string): void {
    if (maxUtteranceTimeouts.has(userId)) {
      return;
    }

    const timeout = setTimeout(() => {
      maxUtteranceTimeouts.delete(userId);
      emitOptionalSegment(flushSingleSpeaker(userId, now(), 'max_utterance'));
    }, maxUtteranceMs);

    maxUtteranceTimeouts.set(userId, timeout);
  }

  function getOrCreateSpeaker(userId: string, atMs: number): SpeakerBufferState {
    const existingSpeaker = speakers.get(userId);

    if (existingSpeaker !== undefined) {
      return existingSpeaker;
    }

    const speaker = createSpeakerState(userId, atMs);
    speakers.set(userId, speaker);
    return speaker;
  }

  return {
    getSpeaker(userId) {
      const normalizedUserId = requireUserId(userId);
      const speaker = speakers.get(normalizedUserId);

      return speaker === undefined ? null : cloneState(speaker);
    },

    markSpeakerActive(input) {
      const atMs = resolveTimestamp(input.atMs, now);
      const userId = requireUserId(input.userId);
      const speaker = getOrCreateSpeaker(userId, atMs);

      speaker.speaking = true;
      speaker.lastVoiceAt = Math.max(speaker.lastVoiceAt, atMs);

      if (speaker.chunks.length === 0) {
        speaker.startedAt = atMs;
      }

      logger.debug({ userId, chunks: speaker.chunks.length }, 'Speaker marked active');

      return cloneState(speaker);
    },

    markSpeakerInactive(input) {
      const atMs = resolveTimestamp(input.atMs, now);
      const userId = requireUserId(input.userId);
      const speaker = speakers.get(userId);

      if (speaker === undefined) {
        return null;
      }

      speaker.speaking = false;
      speaker.lastVoiceAt = Math.max(speaker.lastVoiceAt, atMs);
      scheduleSilenceFlush(userId);

      logger.debug(
        { userId, chunks: speaker.chunks.length },
        'Speaker marked inactive, scheduled silence flush'
      );

      return cloneState(speaker);
    },

    appendChunk(input) {
      const atMs = resolveTimestamp(input.atMs, now);
      const userId = requireUserId(input.userId);
      const chunk = normalizeChunk(input.chunk);
      const segments: VoiceSegment[] = [];
      const existingSpeaker = speakers.get(userId);

      if (
        existingSpeaker !== undefined &&
        shouldFlushForMaxUtterance(existingSpeaker, atMs, maxUtteranceMs)
      ) {
        const flushedSegment = flushSingleSpeaker(userId, atMs, 'max_utterance');

        if (flushedSegment !== null) {
          segments.push(flushedSegment);
        }
      }

      const speaker = getOrCreateSpeaker(userId, atMs);
      speaker.speaking = true;
      speaker.lastVoiceAt = Math.max(speaker.lastVoiceAt, atMs);

      if (speaker.chunks.length === 0) {
        speaker.startedAt = atMs;
      }

      speaker.chunks.push(chunk);
      scheduleSilenceFlush(userId);
      scheduleMaxUtteranceFlush(userId);

      logger.trace(
        { userId, chunkSize: chunk.length, totalChunks: speaker.chunks.length },
        'Audio chunk appended'
      );

      emitSegments(segments);

      return segments;
    },

    pushChunk(input) {
      return this.appendChunk({
        userId: input.speakerId,
        chunk: input.chunk,
        atMs: input.atMs,
      });
    },

    flushSpeaker(input) {
      const atMs = resolveTimestamp(input.atMs, now);
      const userId = requireUserId(input.userId);
      const reason = requireFlushReason(input.reason);

      return emitOptionalSegment(flushSingleSpeaker(userId, atMs, reason));
    },

    flushAll(input = {}) {
      const atMs = resolveTimestamp(input.atMs, now);
      const reason = requireFlushReason(input.reason);
      const segments: VoiceSegment[] = [];

      for (const userId of [...speakers.keys()]) {
        const flushedSegment = flushSingleSpeaker(userId, atMs, reason);

        if (flushedSegment !== null) {
          segments.push(flushedSegment);
        }
      }

      emitSegments(segments);

      return segments;
    },

    flushExpired(atMsInput) {
      const atMs = resolveTimestamp(atMsInput, now);
      const segments: VoiceSegment[] = [];

      for (const [userId, speaker] of [...speakers.entries()]) {
        if (shouldFlushForMaxUtterance(speaker, atMs, maxUtteranceMs)) {
          const flushedSegment = flushSingleSpeaker(userId, atMs, 'max_utterance');

          if (flushedSegment !== null) {
            segments.push(flushedSegment);
          }

          continue;
        }

        if (shouldFlushForSilence(speaker, atMs, silenceTimeoutMs)) {
          const flushedSegment = flushSingleSpeaker(userId, atMs, 'silence_timeout');

          if (flushedSegment !== null) {
            segments.push(flushedSegment);
          }
        }
      }

      emitSegments(segments);

      return segments;
    },

    destroy() {
      return this.flushAll();
    },

    entries() {
      function* speakerEntries(): IterableIterator<[string, SpeakerBufferState]> {
        for (const [userId, speaker] of speakers.entries()) {
          yield [userId, cloneState(speaker)];
        }
      }

      return speakerEntries();
    },
  };
}
