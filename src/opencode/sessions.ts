import type {
  AssistantMessage,
  Session,
  TextPartInput,
  AgentPartInput,
  FilePartInput,
  SubtaskPartInput,
} from '@opencode-ai/sdk';

import type { AssistantOutputPart } from './parts.js';
import { createTextPromptParts, normalizeAssistantResponse } from './parts.js';
import type { OpencodeSdkContext } from './sdk.js';
import { RuntimeError } from '../utils/errors.js';

export type PromptInputPart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

export interface CreateSessionOptions {
  title?: string;
  parentId?: string;
}

export interface PromptSessionOptions {
  sessionId: string;
  parts: readonly PromptInputPart[];
  messageId?: string;
  agent?: string;
  noReply?: boolean;
  system?: string;
  tools?: Record<string, boolean>;
  model?: {
    providerID: string;
    modelID: string;
  };
}

export interface PromptSessionTextOptions extends Omit<PromptSessionOptions, 'parts'> {
  text: string;
}

export interface PromptSessionResult {
  info: AssistantMessage;
  sdkParts: readonly import('@opencode-ai/sdk').Part[];
  parts: readonly AssistantOutputPart[];
}

const OPENCODE_REQUEST_OPTIONS = {
  responseStyle: 'data',
  throwOnError: true,
} as const;

function requireNonEmptyString(name: string, value: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new RuntimeError(`${name} must be a non-empty string`);
  }

  return normalizedValue;
}

function requirePromptParts(parts: readonly PromptInputPart[]): readonly PromptInputPart[] {
  if (parts.length === 0) {
    throw new RuntimeError('parts must contain at least one input part');
  }

  return parts;
}

export async function createSession(
  context: OpencodeSdkContext,
  options: CreateSessionOptions = {},
): Promise<Session> {
  const body =
    options.parentId === undefined && options.title === undefined
      ? undefined
      : {
          parentID: options.parentId === undefined ? undefined : requireNonEmptyString('parentId', options.parentId),
          title: options.title === undefined ? undefined : requireNonEmptyString('title', options.title),
        };

  const response = await context.client.session.create({
    ...OPENCODE_REQUEST_OPTIONS,
    body,
  });

  return response.data;
}

export async function promptSessionParts(
  context: OpencodeSdkContext,
  options: PromptSessionOptions,
): Promise<PromptSessionResult> {
  const sessionId = requireNonEmptyString('sessionId', options.sessionId);
  const parts = requirePromptParts(options.parts);

  const response = await context.client.session.prompt({
    ...OPENCODE_REQUEST_OPTIONS,
    path: { id: sessionId },
    body: {
      messageID: options.messageId,
      model: options.model,
      agent: options.agent,
      noReply: options.noReply,
      system: options.system,
      tools: options.tools,
      parts: [...parts],
    },
  });
  const promptResult = response.data;

  return {
    info: promptResult.info,
    sdkParts: promptResult.parts,
    parts: normalizeAssistantResponse(promptResult),
  };
}

export async function promptSessionText(
  context: OpencodeSdkContext,
  options: PromptSessionTextOptions,
): Promise<PromptSessionResult> {
  return promptSessionParts(context, {
    ...options,
    parts: createTextPromptParts(options.text),
  });
}
