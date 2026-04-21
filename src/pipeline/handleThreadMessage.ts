import type { AnyThreadChannel } from 'discord.js';

import type { SentDiscordPart } from '../discord/replies.js';
import { createTextPromptParts } from '../opencode/parts.js';
import type { OpencodeSdkContext } from '../opencode/sdk.js';
import { createSession, promptSessionParts, type PromptSessionResult } from '../opencode/sessions.js';
import type { ThreadSessionRepo } from '../storage/threadSessionRepo.js';
import { RuntimeError } from '../utils/errors.js';
import { handleAssistantParts } from './handleAssistantParts.js';

export interface HandleThreadMessageDependencies {
  opencode: OpencodeSdkContext;
  threadSessionRepo: ThreadSessionRepo;
}

export interface HandleThreadMessageOptions {
  thread: AnyThreadChannel;
  text: string;
}

export interface HandleThreadMessageResult {
  sessionId: string;
  createdSession: boolean;
  promptResult: PromptSessionResult;
  sentParts: readonly SentDiscordPart[];
}

function requireMessageText(text: string): string {
  const normalizedText = text.trim();

  if (normalizedText.length === 0) {
    throw new RuntimeError('text must be a non-empty string', 400);
  }

  return normalizedText;
}

async function resolveThreadSession(
  dependencies: HandleThreadMessageDependencies,
  thread: AnyThreadChannel,
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

export async function handleThreadMessage(
  dependencies: HandleThreadMessageDependencies,
  options: HandleThreadMessageOptions,
): Promise<HandleThreadMessageResult> {
  const text = requireMessageText(options.text);
  const threadSession = await resolveThreadSession(dependencies, options.thread);
  const promptResult = await promptSessionParts(dependencies.opencode, {
    sessionId: threadSession.sessionId,
    parts: createTextPromptParts(text),
  });
  const sentParts = await handleAssistantParts({
    thread: options.thread,
    parts: promptResult.parts,
  });

  return {
    sessionId: threadSession.sessionId,
    createdSession: threadSession.createdSession,
    promptResult,
    sentParts,
  };
}
