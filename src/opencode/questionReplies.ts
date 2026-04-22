import type { OpencodeSdkContext } from './sdk.js';
import { RuntimeError, toError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'opencode:question-replies' });

export interface SubmitQuestionReplyOptions {
  questionId: string;
  answers: string[][];
}

interface QuestionLookupItem {
  id?: unknown;
  sessionID?: unknown;
  tool?: {
    messageID?: unknown;
    callID?: unknown;
  };
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

export async function resolveQuestionId(
  context: OpencodeSdkContext,
  sessionId: string,
  toolMessageId: string
): Promise<string> {
  const url = `${context.baseUrl}/question`;
  logger.debug({ sessionId, toolMessageId, url }, 'Fetching question list to resolve id');
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
    const candidateMessageId =
      isRecord(item.tool) && typeof item.tool.messageID === 'string'
        ? item.tool.messageID.trim()
        : '';
    return candidateSessionId === sessionId && candidateMessageId === toolMessageId;
  });

  const questionId = typeof match?.id === 'string' ? match.id.trim() : '';
  if (questionId.length === 0) {
    throw new RuntimeError(
      `Could not resolve question id for session ${sessionId} and tool message ${toolMessageId}`,
      404
    );
  }

  logger.debug(
    {
      sessionId,
      toolMessageId,
      questionId,
      candidateCount: items.length,
    },
    'Resolved question id from question list'
  );

  return questionId;
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
