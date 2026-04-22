import OpenAI, { APIError } from 'openai';
import { File, Headers } from 'undici';
import type { Dispatcher, HeadersInit } from 'undici';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'asr:client' });

export const DEFAULT_ASR_ENDPOINT_PATH = '/audio/transcriptions';
export const DEFAULT_WAV_FILENAME = 'audio.wav';
export const DEFAULT_WAV_CONTENT_TYPE = 'audio/wav';

export interface AsrClientConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  endpointPath?: string;
  headers?: HeadersInit;
  dispatcher?: Dispatcher;
}

export interface AsrClientRequestOptions {
  filename?: string;
  contentType?: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface AsrClientResponse {
  ok: boolean;
  statusCode: number;
  statusText: string;
  headers: Headers;
  raw: unknown;
}

export interface AsrClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly endpointPath: string;
  requestWavTranscription(
    audio: Uint8Array,
    options?: AsrClientRequestOptions
  ): Promise<AsrClientResponse>;
}

function requireNonEmptyString(name: string, value: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return normalizedValue;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '');
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(requireNonEmptyString('baseUrl', value));
  return trimTrailingSlashes(url.toString());
}

function normalizeEndpointPath(value: string): string {
  const normalizedValue = requireNonEmptyString('endpointPath', value);
  return normalizedValue.startsWith('/') ? normalizedValue : `/${normalizedValue}`;
}

function normalizeOptionalApiKey(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length === 0 ? undefined : normalizedValue;
}

function createOpenAiApiKey(value?: string): string {
  return normalizeOptionalApiKey(value) ?? 'EMPTY';
}

function mergeHeaders(defaultHeaders?: HeadersInit, requestHeaders?: HeadersInit): Headers {
  const headers = new Headers(defaultHeaders);

  if (requestHeaders !== undefined) {
    new Headers(requestHeaders).forEach((headerValue, headerName) => {
      headers.set(headerName, headerValue);
    });
  }

  if (!headers.has('accept')) {
    headers.set('accept', 'application/json');
  }

  return headers;
}

function readOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length === 0 ? undefined : normalizedValue;
}

function buildAudioFile(audio: Uint8Array, options: AsrClientRequestOptions = {}): File {
  const filename = readOptionalString(options.filename) ?? DEFAULT_WAV_FILENAME;
  const contentType = readOptionalString(options.contentType) ?? DEFAULT_WAV_CONTENT_TYPE;
  const file = new File([audio], filename, { type: contentType });

  logger.debug(
    {
      filename,
      contentType,
      audioBytes: audio.byteLength,
    },
    'Building ASR request file'
  );

  return file;
}

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function createFetchOptions(dispatcher?: Dispatcher): Record<string, unknown> | undefined {
  if (dispatcher === undefined) {
    return undefined;
  }

  return { dispatcher };
}

function buildErrorResponse(error: APIError): AsrClientResponse | null {
  if (error.status === undefined) {
    return null;
  }

  return {
    ok: false,
    statusCode: error.status,
    statusText: error.message,
    headers: new Headers(error.headers),
    raw: error.error ?? { message: error.message },
  };
}

export function createAsrClient(config: AsrClientConfig): AsrClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = requireNonEmptyString('model', config.model);
  const endpointPath = normalizeEndpointPath(config.endpointPath ?? DEFAULT_ASR_ENDPOINT_PATH);
  const defaultHeaders =
    config.headers === undefined ? undefined : headersToObject(new Headers(config.headers));
  const openai = new OpenAI({
    apiKey: createOpenAiApiKey(config.apiKey),
    baseURL: baseUrl,
    defaultHeaders,
    fetchOptions: createFetchOptions(config.dispatcher),
    maxRetries: 0,
  });

  return {
    baseUrl,
    model,
    endpointPath,
    async requestWavTranscription(audio, options = {}) {
      const headers = mergeHeaders(config.headers, options.headers);
      const file = buildAudioFile(audio, options);
      const requestOptions: NonNullable<Parameters<typeof openai.audio.transcriptions.create>[1]> =
        {
          headers: headersToObject(headers),
          signal: options.signal,
        };

      logger.debug(
        {
          baseUrl,
          endpointPath,
          headers: headersToObject(headers),
          audioBytes: audio.byteLength,
          model,
        },
        'Sending ASR request'
      );

      try {
        const { data, response } = await openai.audio.transcriptions
          .create(
            {
              model,
              file,
            },
            requestOptions
          )
          .withResponse();

        logger.debug(
          {
            statusCode: response.status,
            statusText: response.statusText,
            ok: response.ok,
            raw: data,
          },
          'Received ASR response'
        );

        return {
          ok: response.ok,
          statusCode: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
          raw: data,
        };
      } catch (error) {
        if (error instanceof APIError) {
          const response = buildErrorResponse(error);

          if (response !== null) {
            logger.debug(
              {
                statusCode: response.statusCode,
                statusText: response.statusText,
                ok: response.ok,
                raw: response.raw,
              },
              'Received ASR error response'
            );

            return response;
          }
        }

        throw error;
      }
    },
  };
}
