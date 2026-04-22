import type {
  AssistantMessage,
  FilePart,
  Part as OpencodePart,
  TextPartInput,
  ToolPart,
} from '@opencode-ai/sdk';

import { RuntimeError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'opencode:parts' });

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
  startTime?: number;
  input: Record<string, unknown>;
  rawInput: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface AssistantQuestionOption {
  label: string;
  description: string;
}

export interface AssistantQuestionInfo {
  question: string;
  header: string;
  options: readonly AssistantQuestionOption[];
  multiple: boolean;
  custom: boolean;
}

export interface AssistantQuestionToolCall {
  requestId?: string;
  sessionId: string;
  toolMessageId: string;
  questionId?: string;
  callId: string;
  tool: string;
  questions: readonly AssistantQuestionInfo[];
}

export interface AssistantToolResultPart extends AssistantPartBase {
  type: 'tool_result';
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  title: string;
  startTime: number;
  endTime: number;
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

export interface AssistantStepStartPart extends AssistantPartBase {
  type: 'step_start';
  stepType: string;
  metadata?: Record<string, unknown>;
}

export interface AssistantStepFinishPart extends AssistantPartBase {
  type: 'step_finish';
  stepType: string;
  metadata?: Record<string, unknown>;
}

export interface AssistantPatchPart extends AssistantPartBase {
  type: 'patch';
  hash: string;
  files: readonly string[];
  metadata?: Record<string, unknown>;
}

export type AssistantOutputPart =
  | AssistantTextPart
  | AssistantReasoningPart
  | AssistantToolCallPart
  | AssistantToolResultPart
  | AssistantErrorPart
  | AssistantUnknownPart
  | AssistantStepStartPart
  | AssistantPatchPart
  | AssistantStepFinishPart;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isQuestionOption(value: AssistantQuestionOption | null): value is AssistantQuestionOption {
  return value !== null;
}

function isQuestionInfo(value: AssistantQuestionInfo | null): value is AssistantQuestionInfo {
  return value !== null;
}

function parseQuestionOption(value: unknown): AssistantQuestionOption | null {
  if (!isRecord(value)) {
    return null;
  }

  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const description = typeof value.description === 'string' ? value.description.trim() : '';

  if (label.length === 0 || description.length === 0) {
    return null;
  }

  return {
    label,
    description,
  };
}

function parseQuestionInfo(value: unknown): AssistantQuestionInfo | null {
  if (!isRecord(value)) {
    return null;
  }

  const question = typeof value.question === 'string' ? value.question.trim() : '';
  const header = typeof value.header === 'string' ? value.header.trim() : '';
  const parsedOptions = Array.isArray(value.options)
    ? value.options.map((option) => parseQuestionOption(option))
    : [];

  if (question.length === 0 || header.length === 0 || parsedOptions.length === 0) {
    return null;
  }

  if (parsedOptions.some((option) => option === null)) {
    return null;
  }

  const options = parsedOptions.filter(isQuestionOption);

  return {
    question,
    header,
    options,
    multiple: typeof value.multiple === 'boolean' ? value.multiple : false,
    custom: typeof value.custom === 'boolean' ? value.custom : true,
  };
}

function parseQuestionPayload(value: unknown): {
  requestId?: string;
  questions: readonly AssistantQuestionInfo[];
} | null {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length === 0) {
    return null;
  }

  const parsedQuestions = value.questions.map((question) => parseQuestionInfo(question));

  if (parsedQuestions.some((question) => question === null)) {
    return null;
  }

  const questions = parsedQuestions.filter(isQuestionInfo);
  const requestIdCandidates = [value.id, value.requestId, value.requestID];
  const requestId = requestIdCandidates.find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
  );

  return {
    requestId: requestId?.trim(),
    questions,
  };
}

function parseRawQuestionPayload(rawInput: string): {
  requestId?: string;
  questions: readonly AssistantQuestionInfo[];
} | null {
  const normalizedRawInput = rawInput.trim();

  if (normalizedRawInput.length === 0) {
    return null;
  }

  try {
    return parseQuestionPayload(JSON.parse(normalizedRawInput));
  } catch {
    return null;
  }
}

function createPartBase(
  part: Pick<OpencodePart, 'id' | 'sessionID' | 'messageID'>
): AssistantPartBase {
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

function normalizeToolPart(
  part: ToolPart
): AssistantToolCallPart | AssistantToolResultPart | AssistantErrorPart {
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
        startTime: part.state.time.start,
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
        startTime: part.state.time.start,
        endTime: part.state.time.end,
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
      return createUnknownPart(
        part,
        `Unsupported assistant part type "${part.type}" from agent "${part.agent}"`
      );

    case 'step-start': {
      const stepStartPart = part as unknown as Record<string, unknown>;
      return {
        ...createPartBase(part),
        type: 'step_start' as const,
        stepType: typeof stepStartPart.stepType === 'string' ? stepStartPart.stepType : 'unknown',
        metadata: toRecord(
          typeof stepStartPart.metadata === 'object' && stepStartPart.metadata !== null
            ? (stepStartPart.metadata as Record<string, unknown>)
            : undefined
        ),
      };
    }

    case 'step-finish': {
      const stepFinishPart = part as unknown as Record<string, unknown>;
      return {
        ...createPartBase(part),
        type: 'step_finish' as const,
        stepType: typeof stepFinishPart.stepType === 'string' ? stepFinishPart.stepType : 'unknown',
        metadata: toRecord(
          typeof stepFinishPart.metadata === 'object' && stepFinishPart.metadata !== null
            ? (stepFinishPart.metadata as Record<string, unknown>)
            : undefined
        ),
      };
    }
    case 'file':
    case 'snapshot':
      return createUnknownPart(part, `Unsupported assistant part type "${part.type}"`);

    case 'patch': {
      const patchPart = part as unknown as {
        hash: string;
        files: string[];
        metadata?: Record<string, unknown>;
      };
      return {
        ...createPartBase(part),
        type: 'patch',
        hash: patchPart.hash,
        files: [...patchPart.files],
        metadata: toRecord(patchPart.metadata),
      };
    }
    case 'agent':
    case 'retry':
    case 'compaction':
      return createUnknownPart(part, `Unsupported assistant part type "${part.type}"`);

    default:
      return assertUnreachable(part);
  }
}

export function parseAssistantQuestionToolCall(
  part: AssistantToolCallPart
): AssistantQuestionToolCall | null {
  const parsedPayload = parseQuestionPayload(part.input) ?? parseRawQuestionPayload(part.rawInput);

  logger.debug(
    {
      partId: part.id,
      callId: part.callId,
      tool: part.tool,
      sessionId: part.sessionId,
      input: part.input,
      rawInput: part.rawInput,
      parsedRequestId: parsedPayload?.requestId,
      parsedQuestionCount: parsedPayload?.questions.length ?? 0,
    },
    'Received question tool body'
  );

  if (parsedPayload === null) {
    return null;
  }

  const result: AssistantQuestionToolCall = {
    requestId: parsedPayload.requestId,
    sessionId: part.sessionId,
    toolMessageId: part.messageId,
    questionId: undefined,
    callId: part.callId,
    tool: part.tool,
    questions: parsedPayload.questions,
  };

  logger.debug({ result }, 'Parsed assistant question tool call');

  return result;
}

export function normalizeAssistantError(
  error: AssistantMessageError,
  messageId: string,
  sessionId: string
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

export function normalizeAssistantOutputParts(
  parts: readonly OpencodePart[]
): AssistantOutputPart[] {
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
