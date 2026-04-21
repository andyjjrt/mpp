import type { Headers } from 'undici';

import { loadConfig } from '../config.js';
import type { AppConfig } from '../types.js';
import { AppError, toError } from '../utils/errors.js';
import {
  createAsrClient,
  type AsrClient,
  type AsrClientResponse,
} from './client.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MINIMUM_TRANSCRIPT_CHARACTERS = 2;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

export type AsrTranscriptionErrorCode =
  | 'ASR_CONFIGURATION_ERROR'
  | 'ASR_TIMEOUT'
  | 'ASR_NETWORK_ERROR'
  | 'ASR_RATE_LIMITED'
  | 'ASR_BAD_REQUEST'
  | 'ASR_UNAUTHORIZED'
  | 'ASR_FORBIDDEN'
  | 'ASR_NOT_FOUND'
  | 'ASR_SERVER_ERROR'
  | 'ASR_HTTP_ERROR'
  | 'ASR_INVALID_RESPONSE'
  | 'ASR_EMPTY_TRANSCRIPT'
  | 'ASR_TRANSCRIPT_TOO_SHORT';

export interface AsrTranscriptionResult {
  text: string;
  raw?: unknown;
}

export interface NormalizedWavInput {
  data: Uint8Array;
  fileName?: string;
  contentType?: string;
  durationMs?: number;
  sampleRateHz?: number;
}

export interface LegacyAsrTranscriptionSuccess {
  ok: true;
  transcript: AsrTranscriptionResult;
}

export interface LegacyAsrTranscriptionFailure {
  ok: false;
  error: {
    code: AsrTranscriptionErrorCode;
    message: string;
    retryable: boolean;
    statusCode: number;
    attempts: number;
    raw?: unknown;
  };
}

export type LegacyAsrTranscriptionResult = LegacyAsrTranscriptionSuccess | LegacyAsrTranscriptionFailure;

export interface TranscribeWavOptions {
  asr?: AppConfig['asr'];
  client?: AsrClient;
  contentType?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  minimumTranscriptCharacters?: number;
  signal?: AbortSignal;
}

interface ClassifiedStatus {
  code: AsrTranscriptionErrorCode;
  retryable: boolean;
}

interface NormalizedTranscriptPayload {
  text: string;
}

interface ResolvedAsrConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

interface AttemptSignal {
  signal: AbortSignal;
  didTimeout(): boolean;
  cleanup(): void;
}

export class AsrTranscriptionError extends AppError {
  readonly retryable: boolean;
  readonly attempts: number;
  readonly raw?: unknown;

  constructor(options: {
    code: AsrTranscriptionErrorCode;
    message: string;
    retryable?: boolean;
    statusCode?: number;
    attempts?: number;
    raw?: unknown;
    cause?: unknown;
  }) {
    super(options.message, options.code, options.statusCode ?? 502, true);
    this.retryable = options.retryable ?? false;
    this.attempts = options.attempts ?? 1;
    this.raw = options.raw;

    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }
}

function readOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length === 0 ? undefined : normalizedValue;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AsrTranscriptionError({
      code: 'ASR_CONFIGURATION_ERROR',
      message: `${name} must be a positive integer`,
      retryable: false,
      statusCode: 500,
    });
  }

  return value;
}

function requireAudioBuffer(audio: Uint8Array): Uint8Array {
  if (!(audio instanceof Uint8Array)) {
    throw new AsrTranscriptionError({
      code: 'ASR_CONFIGURATION_ERROR',
      message: 'audio must be a Buffer or Uint8Array',
      retryable: false,
      statusCode: 500,
    });
  }

  if (audio.byteLength === 0) {
    throw new AsrTranscriptionError({
      code: 'ASR_CONFIGURATION_ERROR',
      message: 'WAV buffer must contain audio data',
      retryable: false,
      statusCode: 500,
    });
  }

  return audio;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length === 0 ? undefined : normalizedValue;
}

function getNestedValue(value: unknown, path: readonly (string | number)[]): unknown {
  let currentValue: unknown = value;

  for (const segment of path) {
    if (Array.isArray(currentValue)) {
      if (typeof segment !== 'number') {
        return undefined;
      }

      currentValue = currentValue[segment];
      continue;
    }

    if (!isRecord(currentValue)) {
      return undefined;
    }

    currentValue = currentValue[segment];
  }

  return currentValue;
}

function extractMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return readString(value);
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const directCandidates = [value.message, value.error, value.detail, value.title];

  for (const candidate of directCandidates) {
    const message = extractMessage(candidate);

    if (message !== undefined) {
      return message;
    }
  }

  return undefined;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function countVisibleTranscriptCharacters(value: string): number {
  return value.replace(/[^\p{L}\p{N}]+/gu, '').length;
}

function normalizeTranscriptPayload(payload: unknown): NormalizedTranscriptPayload | null {
  const directTranscript = readString(payload);

  if (directTranscript !== undefined) {
    return { text: directTranscript };
  }

  const transcriptText =
    readString(getNestedValue(payload, ['text']))
    ?? readString(getNestedValue(payload, ['transcript']))
    ?? readString(getNestedValue(payload, ['result', 'text']))
    ?? readString(getNestedValue(payload, ['result', 'transcript']))
    ?? readString(getNestedValue(payload, ['results', 'channels', 0, 'alternatives', 0, 'transcript']));

  if (transcriptText === undefined) {
    return null;
  }

  return { text: transcriptText };
}

function classifyStatusCode(statusCode: number): ClassifiedStatus {
  if (statusCode === 408) {
    return { code: 'ASR_TIMEOUT', retryable: true };
  }

  if (statusCode === 429) {
    return { code: 'ASR_RATE_LIMITED', retryable: true };
  }

  if (statusCode === 400 || statusCode === 422) {
    return { code: 'ASR_BAD_REQUEST', retryable: false };
  }

  if (statusCode === 401) {
    return { code: 'ASR_UNAUTHORIZED', retryable: false };
  }

  if (statusCode === 403) {
    return { code: 'ASR_FORBIDDEN', retryable: false };
  }

  if (statusCode === 404) {
    return { code: 'ASR_NOT_FOUND', retryable: false };
  }

  if (statusCode >= 500) {
    return { code: 'ASR_SERVER_ERROR', retryable: true };
  }

  return {
    code: 'ASR_HTTP_ERROR',
    retryable: RETRYABLE_STATUS_CODES.has(statusCode),
  };
}

function resolveRetryAfterDelayMs(headers: Headers, retryDelayMs: number): number {
  const retryAfter = headers.get('retry-after');

  if (retryAfter === null) {
    return retryDelayMs;
  }

  const numericDelaySeconds = Number(retryAfter);

  if (Number.isFinite(numericDelaySeconds) && numericDelaySeconds >= 0) {
    return Math.max(retryDelayMs, Math.round(numericDelaySeconds * 1_000));
  }

  const retryAt = new Date(retryAfter).getTime();

  if (Number.isNaN(retryAt)) {
    return retryDelayMs;
  }

  return Math.max(retryDelayMs, retryAt - Date.now());
}

function resolveRetryDelayMs(attempt: number, baseRetryDelayMs: number): number {
  return baseRetryDelayMs * 2 ** Math.max(0, attempt - 1);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function createAttemptSignal(timeoutMs: number, upstreamSignal?: AbortSignal): AttemptSignal {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`ASR request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const forwardAbort = () => {
    controller.abort(upstreamSignal?.reason);
  };

  if (upstreamSignal?.aborted === true) {
    forwardAbort();
  } else {
    upstreamSignal?.addEventListener('abort', forwardAbort, { once: true });
  }

  return {
    signal: controller.signal,
    didTimeout() {
      return timedOut;
    },
    cleanup() {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}

function resolveAsrConfig(asr?: AppConfig['asr']): ResolvedAsrConfig {
  const resolvedAsr = asr ?? loadConfig().asr;
  const baseUrl = readOptionalString(resolvedAsr.baseUrl);
  const model = readOptionalString(resolvedAsr.model);

  if (baseUrl === undefined) {
    throw new AsrTranscriptionError({
      code: 'ASR_CONFIGURATION_ERROR',
      message: 'ASR_BASE_URL must be configured before transcription can run',
      retryable: false,
      statusCode: 500,
    });
  }

  if (model === undefined) {
    throw new AsrTranscriptionError({
      code: 'ASR_CONFIGURATION_ERROR',
      message: 'ASR_MODEL must be configured before transcription can run',
      retryable: false,
      statusCode: 500,
    });
  }

  return {
    apiKey: readOptionalString(resolvedAsr.apiKey),
    baseUrl,
    model,
  };
}

function createClientFromOptions(options: TranscribeWavOptions): AsrClient {
  if (options.client !== undefined) {
    return options.client;
  }

  const asr = resolveAsrConfig(options.asr);

  return createAsrClient({
    baseUrl: asr.baseUrl,
    apiKey: asr.apiKey,
    model: asr.model,
  });
}

function createHttpFailure(response: AsrClientResponse, attempts: number): AsrTranscriptionError {
  const classification = classifyStatusCode(response.statusCode);

  return new AsrTranscriptionError({
    code: classification.code,
    message: extractMessage(response.raw) ?? (response.statusText || 'ASR request failed'),
    retryable: classification.retryable,
    statusCode: response.statusCode,
    attempts,
    raw: response.raw,
  });
}

function createTransportFailure(error: unknown, attempts: number, timeoutMs: number, timedOut: boolean): AsrTranscriptionError {
  const normalizedError = toError(error);

  if (timedOut || normalizedError.name === 'TimeoutError') {
    return new AsrTranscriptionError({
      code: 'ASR_TIMEOUT',
      message: `ASR request timed out after ${timeoutMs}ms`,
      retryable: true,
      statusCode: 504,
      attempts,
      cause: normalizedError,
    });
  }

  return new AsrTranscriptionError({
    code: 'ASR_NETWORK_ERROR',
    message: `ASR request failed: ${normalizedError.message}`,
    retryable: true,
    statusCode: 502,
    attempts,
    cause: normalizedError,
  });
}

function createTranscriptFailure(
  code: Extract<AsrTranscriptionErrorCode, 'ASR_INVALID_RESPONSE' | 'ASR_EMPTY_TRANSCRIPT' | 'ASR_TRANSCRIPT_TOO_SHORT'>,
  message: string,
  attempts: number,
  statusCode: number,
  raw: unknown,
): AsrTranscriptionError {
  return new AsrTranscriptionError({
    code,
    message,
    retryable: false,
    statusCode,
    attempts,
    raw,
  });
}

export function isAsrTranscriptionError(error: unknown): error is AsrTranscriptionError {
  return error instanceof AsrTranscriptionError;
}

export async function transcribeWav(
  buffer: Uint8Array,
  filename?: string,
  options: TranscribeWavOptions = {},
): Promise<AsrTranscriptionResult> {
  const audio = requireAudioBuffer(buffer);
  const client = createClientFromOptions(options);
  const timeoutMs = requirePositiveInteger('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxAttempts = requirePositiveInteger('maxAttempts', options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs = requirePositiveInteger('retryDelayMs', options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const minimumTranscriptCharacters = requirePositiveInteger(
    'minimumTranscriptCharacters',
    options.minimumTranscriptCharacters ?? DEFAULT_MINIMUM_TRANSCRIPT_CHARACTERS,
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptSignal = createAttemptSignal(timeoutMs, options.signal);

    try {
      const response = await client.requestWavTranscription(audio, {
        contentType: options.contentType,
        filename,
        signal: attemptSignal.signal,
      });

      if (!response.ok) {
        const failure = createHttpFailure(response, attempt);

        if (!failure.retryable || attempt >= maxAttempts) {
          throw failure;
        }

        await sleep(resolveRetryAfterDelayMs(response.headers, resolveRetryDelayMs(attempt, retryDelayMs)));
        continue;
      }

      const normalizedTranscript = normalizeTranscriptPayload(response.raw);

      if (normalizedTranscript === null) {
        throw createTranscriptFailure(
          'ASR_INVALID_RESPONSE',
          'ASR response did not include a transcript string',
          attempt,
          response.statusCode,
          response.raw,
        );
      }

      const text = collapseWhitespace(normalizedTranscript.text);

      if (text.length === 0) {
        throw createTranscriptFailure(
          'ASR_EMPTY_TRANSCRIPT',
          'ASR returned an empty transcript',
          attempt,
          response.statusCode,
          response.raw,
        );
      }

      if (countVisibleTranscriptCharacters(text) < minimumTranscriptCharacters) {
        throw createTranscriptFailure(
          'ASR_TRANSCRIPT_TOO_SHORT',
          `ASR transcript was shorter than the required ${minimumTranscriptCharacters} visible characters`,
          attempt,
          response.statusCode,
          response.raw,
        );
      }

      return {
        text,
        raw: response.raw,
      };
    } catch (error) {
      const wrappedError = isAsrTranscriptionError(error)
        ? error
        : createTransportFailure(error, attempt, timeoutMs, attemptSignal.didTimeout());

      if (!wrappedError.retryable || attempt >= maxAttempts) {
        throw wrappedError;
      }

      await sleep(resolveRetryDelayMs(attempt, retryDelayMs));
    } finally {
      attemptSignal.cleanup();
    }
  }

  throw new AsrTranscriptionError({
    code: 'ASR_CONFIGURATION_ERROR',
    message: 'ASR transcription could not be executed',
    retryable: false,
    statusCode: 500,
    attempts: maxAttempts,
  });
}

export async function transcribeNormalizedWav(
  config: AppConfig,
  input: NormalizedWavInput,
  options: Omit<TranscribeWavOptions, 'asr'> = {},
): Promise<LegacyAsrTranscriptionResult> {
  void input.durationMs;
  void input.sampleRateHz;

  try {
    const transcript = await transcribeWav(input.data, input.fileName, {
      ...options,
      asr: config.asr,
      contentType: input.contentType,
    });

    return {
      ok: true,
      transcript,
    };
  } catch (error) {
    if (isAsrTranscriptionError(error)) {
      return {
        ok: false,
        error: {
          code: error.code as AsrTranscriptionErrorCode,
          message: error.message,
          retryable: error.retryable,
          statusCode: error.statusCode,
          attempts: error.attempts,
          raw: error.raw,
        },
      };
    }

    throw error;
  }
}
