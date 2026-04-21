import { File, FormData, Headers, fetch } from 'undici';
import type { Dispatcher, HeadersInit, Response } from 'undici';

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
  requestWavTranscription(audio: Uint8Array, options?: AsrClientRequestOptions): Promise<AsrClientResponse>;
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

function mergeHeaders(defaultHeaders?: HeadersInit, requestHeaders?: HeadersInit, apiKey?: string): Headers {
  const headers = new Headers(defaultHeaders);

  if (requestHeaders !== undefined) {
    new Headers(requestHeaders).forEach((headerValue, headerName) => {
      headers.set(headerName, headerValue);
    });
  }

  if (!headers.has('accept')) {
    headers.set('accept', 'application/json');
  }

  if (apiKey !== undefined && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${apiKey}`);
  }

  return headers;
}

function resolveUrl(baseUrl: string, path: string): URL {
  return new URL(path.replace(/^\/+/, ''), `${baseUrl}/`);
}

function readOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue.length === 0 ? undefined : normalizedValue;
}

function buildMultipartBody(model: string, audio: Uint8Array, options: AsrClientRequestOptions = {}): FormData {
  const formData = new FormData();
  const filename = readOptionalString(options.filename) ?? DEFAULT_WAV_FILENAME;
  const contentType = readOptionalString(options.contentType) ?? DEFAULT_WAV_CONTENT_TYPE;

  formData.set('model', model);
  formData.set('file', new File([audio], filename, { type: contentType }));

  return formData;
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const text = await response.text();

  if (text.length === 0) {
    return undefined;
  }

  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return text;
}

export function createAsrClient(config: AsrClientConfig): AsrClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = requireNonEmptyString('model', config.model);
  const endpointPath = normalizeEndpointPath(config.endpointPath ?? DEFAULT_ASR_ENDPOINT_PATH);
  const apiKey = normalizeOptionalApiKey(config.apiKey);

  return {
    baseUrl,
    model,
    endpointPath,
    async requestWavTranscription(audio, options = {}) {
      const response = await fetch(resolveUrl(baseUrl, endpointPath), {
        method: 'POST',
        headers: mergeHeaders(config.headers, options.headers, apiKey),
        body: buildMultipartBody(model, audio, options),
        signal: options.signal,
        dispatcher: config.dispatcher,
      });

      return {
        ok: response.ok,
        statusCode: response.status,
        statusText: response.statusText,
        headers: response.headers,
        raw: await readResponseBody(response),
      };
    },
  };
}
