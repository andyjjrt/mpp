import type { AnyThreadChannel } from 'discord.js';

import {
  createThreadTypingSession,
  sendRepliesToThread,
  type SentDiscordPart,
} from '../discord/replies.js';
import {
  isMessagePartUpdatedEvent,
  isMessageUpdatedEvent,
  isOpenCodeEventForSession,
  isSessionErrorEvent,
  isSessionIdleEvent,
  type OpenCodeEvent,
  subscribeToOpencodeEvents,
} from '../opencode/events.js';
import type { AssistantOutputPart } from '../opencode/parts.js';
import { createTextPromptParts, normalizeAssistantPart } from '../opencode/parts.js';
import type { OpencodeSdkContext } from '../opencode/sdk.js';
import { createSession, promptSessionPartsAsync } from '../opencode/sessions.js';
import type { ThreadSessionRepo } from '../storage/threadSessionRepo.js';
import { RuntimeError, toError } from '../utils/errors.js';
import {
  createStreamingAssistantDispatchState,
  handleStreamingAssistantPart,
  type StreamingAssistantDispatchState,
} from './handleAssistantParts.js';

const EMPTY_ASSISTANT_OUTPUT_FALLBACK = '**Assistant**\n_(assistant returned no output parts)_';
const UNKNOWN_SESSION_ERROR_MESSAGE = 'OpenCode session ended with an unknown error.';

export interface HandleThreadMessageDependencies {
  opencode: OpencodeSdkContext;
  threadSessionRepo: ThreadSessionRepo;
  enableCompletionMention: boolean;
  enableCompletionReport: boolean;
}

export interface HandleThreadMessageOptions {
  thread: AnyThreadChannel;
  text: string;
  firstUserId?: string;
}

export interface PromptStreamResult {
  parts: readonly AssistantOutputPart[];
  terminalEvent: 'session.idle' | 'session.error';
}

export interface HandleThreadMessageResult {
  sessionId: string;
  createdSession: boolean;
  promptResult: PromptStreamResult;
  sentParts: readonly SentDiscordPart[];
}

type StreamLoopWaitResult =
  | { type: 'event'; result: IteratorResult<OpenCodeEvent> }
  | { type: 'prompt_error'; error: unknown };

function requireMessageText(text: string): string {
  const normalizedText = text.trim();

  if (normalizedText.length === 0) {
    throw new RuntimeError('text must be a non-empty string', 400);
  }

  return normalizedText;
}

async function resolveThreadSession(
  dependencies: HandleThreadMessageDependencies,
  thread: AnyThreadChannel
): Promise<{ sessionId: string; createdSession: boolean }> {
  const existingSessionId = dependencies.threadSessionRepo.findSessionId(thread.id);

  if (existingSessionId !== null) {
    return {
      sessionId: existingSessionId,
      createdSession: false,
    };
  }

  const session = await createSession(dependencies.opencode, { title: thread.name });
  dependencies.threadSessionRepo.bind(thread.id, session.id);

  return {
    sessionId: session.id,
    createdSession: true,
  };
}

function createNeverPromise<Result>(): Promise<Result> {
  return new Promise<Result>(() => {});
}

function collectFinalAssistantParts(state: StreamingAssistantDispatchState): AssistantOutputPart[] {
  const finalParts: AssistantOutputPart[] = [];

  for (const partId of state.partOrder) {
    const part = state.finalPartsByPartId.get(partId);

    if (part !== undefined) {
      finalParts.push(part);
    }
  }

  return finalParts;
}

function collectSentDiscordParts(state: StreamingAssistantDispatchState): SentDiscordPart[] {
  const sentParts: SentDiscordPart[] = [];

  for (const partId of state.partOrder) {
    const sentPart = state.sentByPartId.get(partId);

    if (sentPart !== undefined) {
      sentParts.push(sentPart);
    }
  }

  return sentParts;
}
async function fetchAllThreadParticipantIds(thread: AnyThreadChannel): Promise<string[]> {
  const members = await thread.members.fetch();
  const participantIds = new Set<string>();

  for (const member of members.values()) {
    if (member.user && member.user.bot) {
      continue;
    }

    participantIds.add(member.id);
  }

  return Array.from(participantIds);
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
function getSessionErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    const normalizedMessage = error.trim();

    if (normalizedMessage.length > 0) {
      return normalizedMessage;
    }
  }

  if (typeof error === 'object' && error !== null) {
    const errorWithData = error as {
      message?: unknown;
      data?: { message?: unknown };
    };

    if (
      typeof errorWithData.data?.message === 'string' &&
      errorWithData.data.message.trim().length > 0
    ) {
      return errorWithData.data.message;
    }

    if (typeof errorWithData.message === 'string' && errorWithData.message.trim().length > 0) {
      return errorWithData.message;
    }

    try {
      const serializedError = JSON.stringify(error);

      if (
        typeof serializedError === 'string' &&
        serializedError !== '{}' &&
        serializedError.length > 0
      ) {
        return serializedError;
      }
    } catch {
      // Ignore JSON serialization failures and fall back below.
    }
  }

  const normalizedError = toError(error);
  return normalizedError.message === 'Unknown error'
    ? UNKNOWN_SESSION_ERROR_MESSAGE
    : normalizedError.message;
}

async function flushBufferedAssistantParts(
  dependencies: HandleThreadMessageDependencies,
  thread: AnyThreadChannel,
  messageId: string,
  bufferedParts: Map<string, AssistantOutputPart[]>,
  state: StreamingAssistantDispatchState
): Promise<void> {
  const queuedParts = bufferedParts.get(messageId);

  if (queuedParts === undefined) {
    return;
  }

  bufferedParts.delete(messageId);

  for (const part of queuedParts) {
    await handleStreamingAssistantPart({
      opencodeContext: dependencies.opencode,
      thread,
      part,
      state,
    });
  }
}

async function sendSessionErrorReply(thread: AnyThreadChannel, message: string): Promise<void> {
  try {
    await sendRepliesToThread(thread, `**Error**\n${message}`);
  } catch (error) {
    throw new RuntimeError(
      `Failed to send a session error reply in thread ${thread.id}: ${toError(error).message}`
    );
  }
}

export async function handleThreadMessage(
  dependencies: HandleThreadMessageDependencies,
  options: HandleThreadMessageOptions
): Promise<HandleThreadMessageResult> {
  const text = requireMessageText(options.text);
  const threadSession = await resolveThreadSession(dependencies, options.thread);
  const firstUserId =
    dependencies.threadSessionRepo.findFirstUserId(options.thread.id) ?? options.firstUserId;
  const preferences = dependencies.threadSessionRepo.findPromptPreferences(options.thread.id);
  const subscription = await subscribeToOpencodeEvents(dependencies.opencode);
  const typingSession = createThreadTypingSession(options.thread);
  const dispatchState = createStreamingAssistantDispatchState({
    agent: preferences.agent ?? undefined,
    firstUserId,
    model: preferences.model
      ? `${preferences.model.providerID}/${preferences.model.modelID}`
      : undefined,
    sessionStartTime: Date.now(),
  });
  const assistantMessageIds = new Set<string>();
  const nonAssistantMessageIds = new Set<string>();
  const bufferedParts = new Map<string, AssistantOutputPart[]>();

  let terminalEvent: PromptStreamResult['terminalEvent'] | null = null;
  let promptPromise: Promise<void> | null = null;

  try {
    await typingSession.start();

    promptPromise = promptSessionPartsAsync(dependencies.opencode, {
      sessionId: threadSession.sessionId,
      parts: createTextPromptParts(text),
      model: preferences.model ?? undefined,
      agent: preferences.agent ?? undefined,
    });
    const promptErrorSignal: Promise<StreamLoopWaitResult> = promptPromise.then(
      () => createNeverPromise<StreamLoopWaitResult>(),
      (error) => ({ type: 'prompt_error', error })
    );

    while (terminalEvent === null) {
      const next = await Promise.race([
        subscription.stream.next().then((result) => ({ type: 'event' as const, result })),
        promptErrorSignal,
      ] satisfies Promise<StreamLoopWaitResult>[]);

      if (next.type === 'prompt_error') {
        throw next.error;
      }

      if (next.result.done) {
        throw new RuntimeError(
          `OpenCode event stream closed before session ${threadSession.sessionId} completed.`
        );
      }

      const event = next.result.value;

      if (!isOpenCodeEventForSession(event, threadSession.sessionId)) {
        continue;
      }

      if (isMessageUpdatedEvent(event)) {
        const { info } = event.properties;

        if (info.role !== 'assistant') {
          nonAssistantMessageIds.add(info.id);
          bufferedParts.delete(info.id);
          continue;
        }

        assistantMessageIds.add(info.id);
        nonAssistantMessageIds.delete(info.id);
        await flushBufferedAssistantParts(
          dependencies,
          options.thread,
          info.id,
          bufferedParts,
          dispatchState
        );
        continue;
      }

      if (isMessagePartUpdatedEvent(event)) {
        const part = normalizeAssistantPart(event.properties.part);

        if (assistantMessageIds.has(part.messageId)) {
          await handleStreamingAssistantPart({
            opencodeContext: dependencies.opencode,
            thread: options.thread,
            part,
            state: dispatchState,
          });
          continue;
        }

        if (nonAssistantMessageIds.has(part.messageId)) {
          continue;
        }

        const queuedParts = bufferedParts.get(part.messageId);

        if (queuedParts === undefined) {
          bufferedParts.set(part.messageId, [part]);
          continue;
        }

        queuedParts.push(part);
        continue;
      }

      if (isSessionIdleEvent(event)) {
        typingSession.stop();
        terminalEvent = 'session.idle';
        break;
      }

      if (isSessionErrorEvent(event)) {
        typingSession.stop();
        terminalEvent = 'session.error';
        await sendSessionErrorReply(options.thread, getSessionErrorMessage(event.properties.error));
        break;
      }
    }

    if (promptPromise !== null) {
      try {
        await promptPromise;
      } catch (error) {
        if (terminalEvent !== 'session.error') {
          throw error;
        }
      }
    }
  } finally {
    typingSession.stop();
    await subscription.close();
  }

  if (terminalEvent === null) {
    throw new RuntimeError(
      `OpenCode session ${threadSession.sessionId} finished without a terminal event.`
    );
  }

  const finalParts = collectFinalAssistantParts(dispatchState);

  if (terminalEvent === 'session.idle' && finalParts.length === 0) {
    await sendRepliesToThread(options.thread, EMPTY_ASSISTANT_OUTPUT_FALLBACK);
  }

  // Send completion mentions if the last part is step_finish
  const lastPart = finalParts[finalParts.length - 1];
  if (
    lastPart?.type === 'step_finish' &&
    dispatchState.completionInfo &&
    dispatchState.firstUserId &&
    dependencies.enableCompletionMention
  ) {
    // Fetch all unique human participants from thread history
    const participantIds = await fetchAllThreadParticipantIds(options.thread);

    // Ensure first user is included (even if they haven't posted in the thread yet)
    const allUserIds = [dispatchState.firstUserId, ...participantIds];
    const uniqueUserIds = [...new Set(allUserIds)];

    // Chunk mentions if more than 100 users (Discord limit)
    const MAX_MENTIONS_PER_MESSAGE = 100;
    const userIdChunks = chunkArray(uniqueUserIds, MAX_MENTIONS_PER_MESSAGE);

    for (const chunk of userIdChunks) {
      const mentionMessage = chunk.map((id) => `<@${id}>`).join(' ');
      await sendRepliesToThread(options.thread, mentionMessage, {
        parse: [],
        users: chunk,
        roles: [],
      });
    }
  }

  // Send completion report (model/agent/time) separately if enabled
  if (
    lastPart?.type === 'step_finish' &&
    dispatchState.completionInfo &&
    dependencies.enableCompletionReport
  ) {
    const { agent, model, duration } = dispatchState.completionInfo;
    const durationDisplay = duration ? ` • ${duration}` : '';
    const reportMessage = `-# ${agent} • ${model}${durationDisplay}`;
    await sendRepliesToThread(options.thread, reportMessage);
  }

  const promptResult: PromptStreamResult = {
    parts: finalParts,
    terminalEvent,
  };
  const sentParts = collectSentDiscordParts(dispatchState);

  return {
    sessionId: threadSession.sessionId,
    createdSession: threadSession.createdSession,
    promptResult,
    sentParts,
  };
}
