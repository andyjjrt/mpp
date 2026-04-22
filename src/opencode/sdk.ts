import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import type { AppConfig } from '../types.js';

export interface OpencodeSdkContext {
  client: OpencodeClient;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '');
}

function resolveBaseUrl(value: string): string {
  const url = new URL(value);

  return trimTrailingSlashes(url.toString());
}

function createAuthorizationHeader(apiKey?: string): string | undefined {
  const normalizedApiKey = apiKey?.trim();

  if (normalizedApiKey === undefined || normalizedApiKey.length === 0) {
    return undefined;
  }

  return `Bearer ${normalizedApiKey}`;
}

export async function createOpencodeSdkContext(
  config: AppConfig,
  directory: string = process.cwd()
): Promise<OpencodeSdkContext> {
  const authorization = createAuthorizationHeader(config.opencode.apiKey);

  return {
    client: createOpencodeClient({
      baseUrl: resolveBaseUrl(config.opencode.baseUrl),
      directory,
      headers: authorization === undefined ? undefined : { Authorization: authorization },
    }),
  };
}
