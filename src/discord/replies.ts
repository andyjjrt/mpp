import type { AnyThreadChannel, Message } from 'discord.js';

import type { AssistantOutputPart } from '../opencode/parts';
import { RuntimeError, toError } from '../utils/errors.js';
import { splitDiscordMessage } from './messageSplitter';
import { renderAssistantPart } from './partRenderer';
import type { RenderedDiscordPart } from './partRenderer';

const EMPTY_ASSISTANT_OUTPUT_FALLBACK = '**Assistant**\n_(assistant returned no output parts)_';

export interface SentDiscordPart {
  renderedPart: RenderedDiscordPart;
  messages: readonly Message<true>[];
}

async function ensureThreadOpen(thread: AnyThreadChannel): Promise<void> {
  if ('archived' in thread && thread.archived && 'setArchived' in thread && typeof thread.setArchived === 'function') {
    try {
      await thread.setArchived(false);
    } catch {
      throw new RuntimeError(`Cannot send replies to archived thread ${thread.id}.`);
    }
  }
}

function assertThreadSendable(thread: AnyThreadChannel): void {
  if ('viewable' in thread && !thread.viewable) {
    throw new RuntimeError(`Thread ${thread.id} is not viewable by this bot.`);
  }

  if ('sendable' in thread && !thread.sendable) {
    throw new RuntimeError(`Thread ${thread.id} is not sendable by this bot.`);
  }
}

async function sendContentChunks(thread: AnyThreadChannel, content: string): Promise<Message<true>[]> {
  const normalizedContent = content.trim();

  if (normalizedContent.length === 0) {
    return [];
  }

  const chunks = splitDiscordMessage(normalizedContent);
  const replies: Message<true>[] = [];

  for (const chunk of chunks) {
    try {
      const message = await thread.send({
        content: chunk,
        allowedMentions: { parse: [] },
      });

      replies.push(message);
    } catch (error) {
      throw new RuntimeError(`Failed to send a message in thread ${thread.id}: ${toError(error).message}`);
    }
  }

  return replies;
}

export async function sendRepliesToThread(
  thread: AnyThreadChannel,
  content: string,
): Promise<readonly Message<true>[]> {
  assertThreadSendable(thread);
  await ensureThreadOpen(thread);
  return sendContentChunks(thread, content);
}

export async function sendAssistantReplies(
  thread: AnyThreadChannel,
  parts: readonly AssistantOutputPart[],
): Promise<SentDiscordPart[]> {
  assertThreadSendable(thread);
  await ensureThreadOpen(thread);

  if (parts.length === 0) {
    await sendContentChunks(thread, EMPTY_ASSISTANT_OUTPUT_FALLBACK);
    return [];
  }

  const sentParts: SentDiscordPart[] = [];

  for (const part of parts) {
    const renderedPart = renderAssistantPart(part);
    const messages = await sendContentChunks(thread, renderedPart.content);

    sentParts.push({ renderedPart, messages });
  }

  return sentParts;
}
