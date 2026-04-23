import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import type { AppConfig } from '../types.js';

export interface OpencodeSdkContext {
    client: OpencodeClient;
    baseUrl: string;
    authorizationHeader?: string;
    directory?: string;
}

function trimTrailingSlashes(value: string): string {
    return value.replace(/\/+$/u, '');
}

function resolveBaseUrl(value: string): string {
    const url = new URL(value);

    return trimTrailingSlashes(url.toString());
}

function createAuthorizationHeader(
    username?: string,
    password?: string
): string | undefined {
    const normalizedUsername = username?.trim();
    const normalizedPassword = password?.trim();

    if (
        normalizedPassword === undefined ||
        normalizedPassword.length === 0
    ) {
        return undefined;
    }

    const credentials = Buffer.from(
        `${normalizedUsername}:${normalizedPassword}`
    ).toString('base64');

    return `Basic ${credentials}`;
}

export async function createOpencodeSdkContext(
    config: AppConfig,
    directory: string | undefined = config.opencode.directory
): Promise<OpencodeSdkContext> {
    const authorizationHeader = createAuthorizationHeader(config.opencode.username, config.opencode.password);
    const baseUrl = resolveBaseUrl(config.opencode.baseUrl);

    return {
        baseUrl,
        authorizationHeader,
        directory,
        client: createOpencodeClient({
            baseUrl,
            directory,
            headers:
                authorizationHeader === undefined ? undefined : { Authorization: authorizationHeader },
        }),
    };
}
