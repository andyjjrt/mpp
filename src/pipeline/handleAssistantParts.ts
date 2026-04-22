import type { AnyThreadChannel } from 'discord.js';

import type { OpencodeSdkContext } from '../opencode/sdk.js';
import type { SentDiscordPart } from '../discord/replies.js';
import {
  sendAssistantReplies,
  sendRepliesToThread,
  upsertAssistantReplyPart,
} from '../discord/replies.js';
import { parseAssistantQuestionToolCall, type AssistantOutputPart } from '../opencode/parts.js';
import { RuntimeError, toError } from '../utils/errors.js';

const EMPTY_ASSISTANT_OUTPUT_FALLBACK = '**Assistant**\n_(assistant returned no output parts)_';
const ASSISTANT_OUTPUT_DISPATCH_ERROR_FALLBACK =
  '**Error**\n_(assistant output could not be delivered to Discord)_';

export interface HandleAssistantPartsOptions {
  opencodeContext: OpencodeSdkContext;
  thread: AnyThreadChannel;
  parts: readonly AssistantOutputPart[];
}

export interface StreamingAssistantDispatchState {
  sentByPartId: Map<string, SentDiscordPart>;
  partOrder: string[];
  finalPartsByPartId: Map<string, AssistantOutputPart>;
  toolCallPartIdByCallId: Map<string, string>;
  agent?: string;
  firstUserId?: string;
  model?: string;
  completionInfo?: {
    agent: string;
    model: string;
    duration: string;
  };
  sessionStartTime: number;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m${remainingSeconds.toString().padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

async function sendDispatchFailureFallback(
  thread: AnyThreadChannel,
  cause: unknown
): Promise<void> {
  try {
    await sendRepliesToThread(thread, ASSISTANT_OUTPUT_DISPATCH_ERROR_FALLBACK);
  } catch (fallbackError) {
    throw new RuntimeError(
      `Failed to dispatch assistant output (${toError(cause).message}) and failed to send fallback reply: ${toError(fallbackError).message}`
    );
  }
}

export function createStreamingAssistantDispatchState(options: {
  agent?: string;
  firstUserId?: string;
  model?: string;
  sessionStartTime: number;
}): StreamingAssistantDispatchState {
  return {
    sentByPartId: new Map<string, SentDiscordPart>(),
    partOrder: [],
    finalPartsByPartId: new Map<string, AssistantOutputPart>(),
    toolCallPartIdByCallId: new Map<string, string>(),
    agent: options.agent,
    firstUserId: options.firstUserId,
    model: options.model,
    sessionStartTime: options.sessionStartTime,
  };
}

export async function handleStreamingAssistantPart(options: {
  opencodeContext: OpencodeSdkContext;
  thread: AnyThreadChannel;
  part: AssistantOutputPart;
  state: StreamingAssistantDispatchState;
}): Promise<void> {
  const { opencodeContext, thread, part, state } = options;

  // Handle tool_result: update the tool call message to show completion
  if (part.type === 'tool_result') {
    const toolCallPartId = state.toolCallPartIdByCallId.get(part.callId);
    if (toolCallPartId) {
      const toolCallPart = state.finalPartsByPartId.get(toolCallPartId);

      if (
        toolCallPart?.type === 'tool_call' &&
        parseAssistantQuestionToolCall(toolCallPart) !== null
      ) {
        return;
      }

      const previousSent = state.sentByPartId.get(toolCallPartId);
      if (previousSent) {
        // Edit the message to show completion icon
        try {
          for (const message of previousSent.messages) {
            // Calculate duration
            let durationStr = '';
            if (part.startTime && part.endTime) {
              const durationMs = part.endTime - part.startTime;
              durationStr = ` (used ${formatDuration(durationMs)})`;
            }

            // Build completion message
            const title = part.title ?? '';
            const newContent = `> :white_check_mark: **${part.tool}** ${title}${durationStr}`;
            await message.edit({ content: newContent });
          }
        } catch (error) {
          // Ignore edit errors
        }
      }
    }
    // Don't create a separate message for tool result
    return;
  }

  // Handle patch: just let it render normally
  if (part.type === 'patch') {
    // Continue to normal rendering below
  }

  // Handle reasoning: skip during streaming, send at end
  if (part.type === 'reasoning') {
    state.finalPartsByPartId.set(part.id, part);
    if (!state.partOrder.includes(part.id)) {
      state.partOrder.push(part.id);
    }
    return;
  }

  // Handle step_finish: store completion info (send only for last one at session end)
  if (part.type === 'step_finish') {
    const agent = state.agent ?? 'default';
    const model = state.model ?? 'default';

    // Calculate total duration from session start
    const durationMs = Date.now() - state.sessionStartTime;
    const durationStr = formatDuration(durationMs);

    // Store completion info to be sent at session end if this is the last part
    state.completionInfo = {
      agent,
      model,
      duration: durationStr,
    };

    // Still track the part for finalParts collection
    state.finalPartsByPartId.set(part.id, part);
    if (!state.partOrder.includes(part.id)) {
      state.partOrder.push(part.id);
    }
    return;
  }

  // Handle tool_call: track the callId mapping
  if (part.type === 'tool_call') {
    state.toolCallPartIdByCallId.set(part.callId, part.id);
  }

  const previous = state.sentByPartId.get(part.id);

  try {
    const sentPart = await upsertAssistantReplyPart(opencodeContext, thread, part, previous);

    if (!state.partOrder.includes(part.id)) {
      state.partOrder.push(part.id);
    }

    state.finalPartsByPartId.set(part.id, part);

    if (sentPart !== null) {
      state.sentByPartId.set(part.id, sentPart);
    }
  } catch (error) {
    await sendDispatchFailureFallback(thread, error);
    throw new RuntimeError(`Failed to dispatch assistant output: ${toError(error).message}`);
  }
}

export async function handleAssistantParts(
  options: HandleAssistantPartsOptions
): Promise<readonly SentDiscordPart[]> {
  if (options.parts.length === 0) {
    await sendRepliesToThread(options.thread, EMPTY_ASSISTANT_OUTPUT_FALLBACK);
    return [];
  }

  try {
    return await sendAssistantReplies(options.opencodeContext, options.thread, options.parts);
  } catch (error) {
    await sendDispatchFailureFallback(options.thread, error);
    throw new RuntimeError(`Failed to dispatch assistant output: ${toError(error).message}`);
  }
}
