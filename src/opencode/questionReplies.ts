import type { AssistantQuestionInfo } from './parts.js';
import type { OpencodeSdkContext } from './sdk.js';
import { RuntimeError, toError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'opencode:question-replies' });
const QUESTION_LOOKUP_RETRY_DELAYS_MS = [150, 300, 600, 1000] as const;

export interface SubmitQuestionReplyOptions {
  questionId: string;
  answers: string[][];
}

interface QuestionLookupItem {
  id?: unknown;
  sessionID?: unknown;
  questions?: unknown;
  tool?: {
    callID?: unknown;
  };
}

export interface ResolvedQuestionToolMessage {
  questionId: string;
  questions: readonly AssistantQuestionInfo[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireNonEmptyString(name: string, value: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new RuntimeError(`${name} must be a non-empty string`);
  }

  return normalizedValue;
}

function normalizeAnswers(answers: string[][]): string[][] {
  if (answers.length === 0) {
    throw new RuntimeError('answers must contain at least one answer group');
  }

  return answers.map((group, groupIndex) => {
    if (group.length === 0) {
      throw new RuntimeError(`answers[${groupIndex}] must contain at least one value`);
    }

    return group.map((value, valueIndex) =>
      requireNonEmptyString(`answers[${groupIndex}][${valueIndex}]`, value)
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseQuestionLookupItems(value: unknown): QuestionLookupItem[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseQuestionOption(value: unknown): AssistantQuestionInfo['options'][number] | null {
  if (!isRecord(value)) {
    return null;
  }

  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const description = typeof value.description === 'string' ? value.description.trim() : '';

  if (label.length === 0 || description.length === 0) {
    return null;
  }

  return { label, description };
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

  if (
    question.length === 0 ||
    header.length === 0 ||
    parsedOptions.length === 0 ||
    parsedOptions.some((option) => option === null)
  ) {
    return null;
  }

  return {
    question,
    header,
    options: parsedOptions.filter(
      (option): option is AssistantQuestionInfo['options'][number] => option !== null
    ),
    multiple: typeof value.multiple === 'boolean' ? value.multiple : false,
    custom: typeof value.custom === 'boolean' ? value.custom : true,
  };
}

function parseLookupQuestions(value: unknown): readonly AssistantQuestionInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsedQuestions = value.map((question) => parseQuestionInfo(question));

  if (parsedQuestions.some((question) => question === null)) {
    return [];
  }

  return parsedQuestions.filter((question): question is AssistantQuestionInfo => question !== null);
}

async function resolveQuestionByToolMessageOnce(
  context: OpencodeSdkContext,
  sessionId: string,
  toolCallId: string
): Promise<ResolvedQuestionToolMessage> {
  const url = `${context.baseUrl}/question`;
  logger.debug({ sessionId, toolCallId, url }, 'Fetching question list to resolve question');
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      ...(context.authorizationHeader === undefined
        ? {}
        : { Authorization: context.authorizationHeader }),
    },
  });

  const responseText = await response.text().catch(() => '');

  if (!response.ok) {
    throw new RuntimeError(
      `Question lookup failed with status ${response.status}${responseText.trim().length > 0 ? `: ${responseText.trim()}` : ''}`,
      response.status
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new RuntimeError('Question lookup returned invalid JSON', 502);
  }

  const items = parseQuestionLookupItems(parsed);
  logger.debug({ candidateCount: items.length }, 'Parsed question lookup items');
  const match = items.find((item) => {
    const candidateSessionId = typeof item.sessionID === 'string' ? item.sessionID.trim() : '';
    const candidateCallId =
      isRecord(item.tool) && typeof item.tool.callID === 'string' ? item.tool.callID.trim() : '';

    return candidateSessionId === sessionId && candidateCallId === toolCallId;
  });

  const questionId = typeof match?.id === 'string' ? match.id.trim() : '';
  const questions = parseLookupQuestions(match?.questions);

  if (questionId.length === 0 || questions.length === 0) {
    logger.debug(
      {
        sessionId,
        toolCallId,
        questionId,
        matchedQuestionCount: questions.length,
        candidateCount: items.length,
      },
      'Question lookup did not produce a renderable question match'
    );
    throw new RuntimeError(
      `Could not resolve question for session ${sessionId} and tool call ${toolCallId}`,
      404
    );
  }

  logger.debug(
    {
      sessionId,
      toolCallId,
      questionId,
      matchedQuestionCount: questions.length,
      candidateCount: items.length,
    },
    'Resolved question from question list'
  );

  return {
    questionId,
    questions,
  };
}

export async function resolveQuestionByToolMessage(
  context: OpencodeSdkContext,
  sessionId: string,
  toolCallId: string
): Promise<ResolvedQuestionToolMessage> {
  let lastError: RuntimeError | null = null;

  for (let attempt = 0; attempt <= QUESTION_LOOKUP_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await resolveQuestionByToolMessageOnce(context, sessionId, toolCallId);
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.statusCode !== 404) {
        throw error;
      }

      lastError = error;
      const retryDelayMs = QUESTION_LOOKUP_RETRY_DELAYS_MS[attempt];

      logger.debug(
        {
          sessionId,
          toolCallId,
          attempt: attempt + 1,
          maxAttempts: QUESTION_LOOKUP_RETRY_DELAYS_MS.length + 1,
          retryDelayMs: retryDelayMs ?? 0,
        },
        retryDelayMs === undefined
          ? 'Question lookup exhausted retries without a visible question record'
          : 'Question lookup missed the question record; retrying'
      );

      if (retryDelayMs === undefined) {
        break;
      }

      await delay(retryDelayMs);
    }
  }

  if (lastError !== null) {
    throw lastError;
  }

  throw new RuntimeError(
    `Could not resolve question for session ${sessionId} and tool call ${toolCallId}`,
    404
  );
}

export async function resolveQuestionId(
  context: OpencodeSdkContext,
  sessionId: string,
  toolCallId: string
): Promise<string> {
  const resolvedQuestion = await resolveQuestionByToolMessage(context, sessionId, toolCallId);
  return resolvedQuestion.questionId;
}

export interface SubmitDeferredQuestionReplyOptions {
  sessionId: string;
  toolCallId: string;
  answers: string[][];
}

export async function submitDeferredQuestionReply(
  context: OpencodeSdkContext,
  options: SubmitDeferredQuestionReplyOptions
): Promise<void> {
  const sessionId = requireNonEmptyString('sessionId', options.sessionId);
  const toolCallId = requireNonEmptyString('toolCallId', options.toolCallId);
  const questionId = await resolveQuestionId(context, sessionId, toolCallId);

  await submitQuestionReply(context, {
    questionId,
    answers: options.answers,
  });
}

export async function submitQuestionReply(
  context: OpencodeSdkContext,
  options: SubmitQuestionReplyOptions
): Promise<void> {
  const questionId = requireNonEmptyString('questionId', options.questionId);
  const answers = normalizeAnswers(options.answers);
  const url = `${context.baseUrl}/question/${encodeURIComponent(questionId)}/reply`;

  logger.debug({ questionId, url }, 'Submitting question reply');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(context.authorizationHeader === undefined
        ? {}
        : { Authorization: context.authorizationHeader }),
    },
    body: JSON.stringify({ answers }),
  });

  if (response.ok) {
    return;
  }

  const responseText = await response.text().catch(() => '');
  const details = responseText.trim();

  throw new RuntimeError(
    `Question reply request failed with status ${response.status}${details.length > 0 ? `: ${details}` : ''}`,
    response.status
  );
}

export async function trySubmitQuestionReply(
  context: OpencodeSdkContext,
  options: SubmitQuestionReplyOptions
): Promise<{ ok: true } | { ok: false; error: RuntimeError }> {
  try {
    await submitQuestionReply(context, options);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RuntimeError
          ? error
          : new RuntimeError(`Failed to submit question reply: ${toError(error).message}`),
    };
  }
}
