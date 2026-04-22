import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import type { AppConfig } from '../types.js';

export interface OpencodeSdkContext {
  client: OpencodeClient;
  baseUrl: string;
  authorizationHeader?: string;
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
  directory: string | undefined = config.opencode.directory
): Promise<OpencodeSdkContext> {
  const authorizationHeader = createAuthorizationHeader(config.opencode.apiKey);
  const baseUrl = resolveBaseUrl(config.opencode.baseUrl);

  return {
    baseUrl,
    authorizationHeader,
    client: createOpencodeClient({
      baseUrl,
      directory,
      headers:
        authorizationHeader === undefined ? undefined : { Authorization: authorizationHeader },
    }),
  };
}
