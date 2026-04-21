import { EmbedBuilder, type AnyThreadChannel, type Message } from 'discord.js';

import type { AssistantOutputPart } from '../opencode/parts';
import { RuntimeError, toError } from '../utils/errors.js';
import { splitDiscordMessage } from './messageSplitter';
import { renderAssistantPart } from './partRenderer';
import type { RenderedDiscordPart } from './partRenderer';

const EMPTY_ASSISTANT_OUTPUT_FALLBACK = '**Assistant**\n_(assistant returned no output parts)_';
const DISCORD_TYPING_REFRESH_INTERVAL_MS = 9000;

export interface SentDiscordPart {
  renderedPart: RenderedDiscordPart;
  messages: readonly Message<true>[];
}

export interface ThreadTypingSession {
  start(): Promise<void>;
  stop(): void;
}

async function ensureThreadOpen(thread: AnyThreadChannel): Promise<void> {
  if (
    'archived' in thread &&
    thread.archived &&
    'setArchived' in thread &&
    typeof thread.setArchived === 'function'
  ) {
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

function getContentChunks(content: string): string[] {
  const normalizedContent = content.trim();

  if (normalizedContent.length === 0) {
    return [];
  }

  return splitDiscordMessage(normalizedContent);
}

async function sendContentChunk(thread: AnyThreadChannel, chunk: string): Promise<Message<true>> {
  try {
    return await thread.send({
      content: chunk,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    throw new RuntimeError(
      `Failed to send a message in thread ${thread.id}: ${toError(error).message}`
    );
  }
}

async function sendEmbedChunk(
  thread: AnyThreadChannel,
  embed: EmbedBuilder
): Promise<Message<true>> {
  try {
    return await thread.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    throw new RuntimeError(
      `Failed to send an embed in thread ${thread.id}: ${toError(error).message}`
    );
  }
}

async function editContentChunk(
  thread: AnyThreadChannel,
  message: Message<true>,
  chunk: string
): Promise<Message<true>> {
  try {
    return await message.edit({
      content: chunk,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    throw new RuntimeError(
      `Failed to edit a message in thread ${thread.id}: ${toError(error).message}`
    );
  }
}

async function deleteContentChunk(thread: AnyThreadChannel, message: Message<true>): Promise<void> {
  try {
    await message.delete();
  } catch (error) {
    throw new RuntimeError(
      `Failed to delete a message in thread ${thread.id}: ${toError(error).message}`
    );
  }
}

async function sendContentChunks(
  thread: AnyThreadChannel,
  content: string
): Promise<Message<true>[]> {
  const chunks = getContentChunks(content);
  const replies: Message<true>[] = [];

  for (const chunk of chunks) {
    replies.push(await sendContentChunk(thread, chunk));
  }

  return replies;
}

export function createThreadTypingSession(thread: AnyThreadChannel): ThreadTypingSession {
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let activeStartToken = 0;
  let pendingStart: Promise<void> | null = null;

  return {
    async start(): Promise<void> {
      while (typingInterval === null) {
        if (pendingStart !== null) {
          await pendingStart;
          continue;
        }

        const startToken = activeStartToken + 1;
        activeStartToken = startToken;

        const startOperation = (async () => {
          assertThreadSendable(thread);
          await ensureThreadOpen(thread);
          await thread.sendTyping();

          if (activeStartToken !== startToken || typingInterval !== null) {
            return;
          }

          typingInterval = setInterval(() => {
            thread.sendTyping().catch(() => {});
          }, DISCORD_TYPING_REFRESH_INTERVAL_MS);
        })();

        pendingStart = startOperation;

        try {
          await startOperation;
        } finally {
          if (pendingStart === startOperation) {
            pendingStart = null;
          }
        }
      }
    },

    stop(): void {
      activeStartToken += 1;

      if (typingInterval !== null) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
    },
  };
}

export async function upsertAssistantReplyPart(
  thread: AnyThreadChannel,
  part: AssistantOutputPart,
  previous?: SentDiscordPart
): Promise<SentDiscordPart | null> {
  assertThreadSendable(thread);
  await ensureThreadOpen(thread);

  if (part.type === 'step_start' || part.type === 'step_finish') {
    return null;
  }

  const renderedPart = renderAssistantPart(part);

  if (renderedPart === null) {
    return null;
  }

  if (previous === undefined) {
    const messages = await sendContentChunks(thread, renderedPart.content);
    return { renderedPart, messages };
  }

  const nextChunks = getContentChunks(renderedPart.content);
  const updatedMessages: Message<true>[] = [];
  const sharedChunkCount = Math.min(previous.messages.length, nextChunks.length);

  for (let index = 0; index < sharedChunkCount; index += 1) {
    const previousMessage = previous.messages[index];
    const nextChunk = nextChunks[index];

    if (previousMessage.content === nextChunk) {
      updatedMessages.push(previousMessage);
      continue;
    }

    updatedMessages.push(await editContentChunk(thread, previousMessage, nextChunk));
  }

  for (let index = sharedChunkCount; index < nextChunks.length; index += 1) {
    updatedMessages.push(await sendContentChunk(thread, nextChunks[index]));
  }

  for (let index = sharedChunkCount; index < previous.messages.length; index += 1) {
    await deleteContentChunk(thread, previous.messages[index]);
  }

  return {
    renderedPart,
    messages: updatedMessages,
  };
}

export async function sendRepliesToThread(
  thread: AnyThreadChannel,
  content: string
): Promise<readonly Message<true>[]> {
  assertThreadSendable(thread);
  await ensureThreadOpen(thread);
  return sendContentChunks(thread, content);
}

export async function sendEmbedRepliesToThread(
  thread: AnyThreadChannel,
  embeds: readonly EmbedBuilder[]
): Promise<readonly Message<true>[]> {
  assertThreadSendable(thread);
  await ensureThreadOpen(thread);

  const messages: Message<true>[] = [];

  for (const embed of embeds) {
    messages.push(await sendEmbedChunk(thread, embed));
  }

  return messages;
}

export async function sendAssistantReplies(
  thread: AnyThreadChannel,
  parts: readonly AssistantOutputPart[]
): Promise<SentDiscordPart[]> {
  assertThreadSendable(thread);
  await ensureThreadOpen(thread);

  if (parts.length === 0) {
    await sendContentChunks(thread, EMPTY_ASSISTANT_OUTPUT_FALLBACK);
    return [];
  }

  const sentParts: SentDiscordPart[] = [];
  const typingSession = createThreadTypingSession(thread);

  try {
    for (const part of parts) {
      if (part.type === 'step_start') {
        await typingSession.start();
        continue;
      }

      if (part.type === 'step_finish') {
        typingSession.stop();
        continue;
      }

      typingSession.stop();

      const sentPart = await upsertAssistantReplyPart(thread, part);

      if (sentPart !== null) {
        sentParts.push(sentPart);
      }
    }
  } finally {
    typingSession.stop();
  }

  return sentParts;
}
