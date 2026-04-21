import type { OpencodeClient, OpencodeClientConfig } from '@opencode-ai/sdk';

import type { AppConfig } from '../types.js';

interface OpencodeSdkModule {
  createOpencodeClient: (config: OpencodeClientConfig) => OpencodeClient;
}

export interface OpencodeSdkContext {
  client: OpencodeClient;
  directory: string;
  baseUrl: string;
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

export function createOpencodeSdkConfig(
  config: AppConfig,
  directory: string = process.cwd(),
): OpencodeClientConfig & { directory: string } {
  const authorization = createAuthorizationHeader(config.opencode.apiKey);

  return {
    baseUrl: resolveBaseUrl(config.opencode.baseUrl),
    directory,
    headers: authorization === undefined ? undefined : { Authorization: authorization },
  };
}

async function createOpencodeClient(config: OpencodeClientConfig): Promise<OpencodeClient> {
  const sdkModule = (await import('@opencode-ai/sdk')) as OpencodeSdkModule;
  const createClient = sdkModule.createOpencodeClient;

  if (typeof createClient !== 'function') {
    throw new Error('Failed to load @opencode-ai/sdk: createOpencodeClient is unavailable');
  }

  return createClient(config);
}

export async function createOpencodeSdkContext(
  config: AppConfig,
  directory: string = process.cwd(),
): Promise<OpencodeSdkContext> {
  const sdkConfig = createOpencodeSdkConfig(config, directory);

  return {
    client: await createOpencodeClient(sdkConfig),
    directory: sdkConfig.directory,
    baseUrl: sdkConfig.baseUrl ?? config.opencode.baseUrl,
  };
}
