import type {
  AssistantMessage,
  FilePart,
  Part as OpencodePart,
  TextPartInput,
  ToolPart,
} from '@opencode-ai/sdk';

import { RuntimeError } from '../utils/errors.js';

export interface AssistantPartBase {
  id: string;
  sessionId: string;
  messageId: string;
}

export interface AssistantTextPart extends AssistantPartBase {
  type: 'text';
  text: string;
  synthetic: boolean;
  ignored: boolean;
  metadata?: Record<string, unknown>;
}

export interface AssistantReasoningPart extends AssistantPartBase {
  type: 'reasoning';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface AssistantToolCallPart extends AssistantPartBase {
  type: 'tool_call';
  callId: string;
  tool: string;
  status: 'pending' | 'running';
  input: Record<string, unknown>;
  rawInput: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface AssistantToolResultPart extends AssistantPartBase {
  type: 'tool_result';
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  attachments: readonly FilePart[];
}

export interface AssistantErrorPart extends AssistantPartBase {
  type: 'error';
  source: 'message' | 'tool';
  message: string;
  name?: string;
  callId?: string;
  tool?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface AssistantUnknownPart extends AssistantPartBase {
  type: 'unknown';
  sdkPartType: string;
  summary: string;
  raw: OpencodePart;
}

export type AssistantOutputPart =
  | AssistantTextPart
  | AssistantReasoningPart
  | AssistantToolCallPart
  | AssistantToolResultPart
  | AssistantErrorPart
  | AssistantUnknownPart;

type AssistantMessageError = NonNullable<AssistantMessage['error']>;

function requireNonEmptyString(name: string, value: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new RuntimeError(`${name} must be a non-empty string`);
  }

  return normalizedValue;
}

function toRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value === undefined ? undefined : { ...value };
}

function createPartBase(part: Pick<OpencodePart, 'id' | 'sessionID' | 'messageID'>): AssistantPartBase {
  return {
    id: part.id,
    sessionId: part.sessionID,
    messageId: part.messageID,
  };
}

function createUnknownPart(part: OpencodePart, summary: string): AssistantUnknownPart {
  return {
    ...createPartBase(part),
    type: 'unknown',
    sdkPartType: part.type,
    summary,
    raw: part,
  };
}

function normalizeToolPart(part: ToolPart): AssistantToolCallPart | AssistantToolResultPart | AssistantErrorPart {
  const base = createPartBase(part);
  const input = { ...part.state.input };

  switch (part.state.status) {
    case 'pending':
      return {
        ...base,
        type: 'tool_call',
        callId: part.callID,
        tool: part.tool,
        status: 'pending',
        input,
        rawInput: part.state.raw,
        metadata: toRecord(part.metadata),
      };

    case 'running':
      return {
        ...base,
        type: 'tool_call',
        callId: part.callID,
        tool: part.tool,
        status: 'running',
        input,
        rawInput: JSON.stringify(part.state.input),
        title: part.state.title,
        metadata: toRecord(part.state.metadata) ?? toRecord(part.metadata),
      };

    case 'completed':
      return {
        ...base,
        type: 'tool_result',
        callId: part.callID,
        tool: part.tool,
        input,
        output: part.state.output,
        title: part.state.title,
        metadata: { ...part.state.metadata },
        attachments: [...(part.state.attachments ?? [])],
      };

    case 'error':
      return {
        ...base,
        type: 'error',
        source: 'tool',
        message: part.state.error,
        callId: part.callID,
        tool: part.tool,
        input,
        metadata: toRecord(part.state.metadata) ?? toRecord(part.metadata),
        raw: part,
      };

    default:
      return assertUnreachable(part.state);
  }
}

function assertUnreachable(value: never): never {
  throw new RuntimeError(`Encountered an unexpected OpenCode SDK value: ${JSON.stringify(value)}`);
}

export function createTextPromptPart(text: string): TextPartInput {
  requireNonEmptyString('text', text);

  return {
    type: 'text',
    text,
  };
}

export function createTextPromptParts(text: string): readonly [TextPartInput] {
  return [createTextPromptPart(text)];
}

export function normalizeAssistantPart(part: OpencodePart): AssistantOutputPart {
  switch (part.type) {
    case 'text':
      return {
        ...createPartBase(part),
        type: 'text',
        text: part.text,
        synthetic: part.synthetic ?? false,
        ignored: part.ignored ?? false,
        metadata: toRecord(part.metadata),
      };

    case 'reasoning':
      return {
        ...createPartBase(part),
        type: 'reasoning',
        text: part.text,
        metadata: toRecord(part.metadata),
      };

    case 'tool':
      return normalizeToolPart(part);

    case 'subtask':
      return createUnknownPart(part, `Unsupported assistant part type "${part.type}" from agent "${part.agent}"`);

    case 'file':
    case 'step-start':
    case 'step-finish':
    case 'snapshot':
    case 'patch':
    case 'agent':
    case 'retry':
    case 'compaction':
      return createUnknownPart(part, `Unsupported assistant part type "${part.type}"`);

    default:
      return assertUnreachable(part);
  }
}

export function normalizeAssistantError(
  error: AssistantMessageError,
  messageId: string,
  sessionId: string,
): AssistantErrorPart {
  const message = error.data.message;

  return {
    id: `${messageId}:error`,
    sessionId,
    messageId,
    type: 'error',
    source: 'message',
    name: error.name,
    message: typeof message === 'string' ? message : JSON.stringify(error.data),
    raw: error,
  };
}

export function normalizeAssistantOutputParts(parts: readonly OpencodePart[]): AssistantOutputPart[] {
  return parts.map((part) => normalizeAssistantPart(part));
}

export function normalizeAssistantResponse(response: {
  info: AssistantMessage;
  parts: readonly OpencodePart[];
}): AssistantOutputPart[] {
  const normalizedParts = normalizeAssistantOutputParts(response.parts);

  if (response.info.error === undefined) {
    return normalizedParts;
  }

  return [
    ...normalizedParts,
    normalizeAssistantError(response.info.error, response.info.id, response.info.sessionID),
  ];
}
