import type { AnyThreadChannel } from 'discord.js';

import type { SentDiscordPart } from '../discord/replies.js';
import { sendAssistantReplies, sendRepliesToThread } from '../discord/replies.js';
import type { AssistantOutputPart } from '../opencode/parts.js';
import { RuntimeError, toError } from '../utils/errors.js';

const EMPTY_ASSISTANT_OUTPUT_FALLBACK = '**Assistant**\n_(assistant returned no output parts)_';
const ASSISTANT_OUTPUT_DISPATCH_ERROR_FALLBACK = '**Error**\n_(assistant output could not be delivered to Discord)_';

export interface HandleAssistantPartsOptions {
  thread: AnyThreadChannel;
  parts: readonly AssistantOutputPart[];
}

async function sendDispatchFailureFallback(thread: AnyThreadChannel, cause: unknown): Promise<void> {
  try {
    await sendRepliesToThread(thread, ASSISTANT_OUTPUT_DISPATCH_ERROR_FALLBACK);
  } catch (fallbackError) {
    throw new RuntimeError(
      `Failed to dispatch assistant output (${toError(cause).message}) and failed to send fallback reply: ${toError(fallbackError).message}`,
    );
  }
}

export async function handleAssistantParts(options: HandleAssistantPartsOptions): Promise<readonly SentDiscordPart[]> {
  if (options.parts.length === 0) {
    await sendRepliesToThread(options.thread, EMPTY_ASSISTANT_OUTPUT_FALLBACK);
    return [];
  }

  try {
    return await sendAssistantReplies(options.thread, options.parts);
  } catch (error) {
    await sendDispatchFailureFallback(options.thread, error);
    throw new RuntimeError(`Failed to dispatch assistant output: ${toError(error).message}`);
  }
}
