import { EmbedBuilder, MessageFlags, type AnyThreadChannel, type Message } from 'discord.js';
import type { APIMessageTopLevelComponent } from 'discord-api-types/v10';

import type { AssistantOutputPart } from '../opencode/parts.js';
import type { OpencodeSdkContext } from '../opencode/sdk.js';
import { RuntimeError, toError } from '../utils/errors.js';
import { splitDiscordMessage } from './messageSplitter.js';
import { renderAssistantPart } from './partRenderer.js';
import type { RenderedDiscordPart } from './partRenderer.js';
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

interface DiscordMessageChunk {
  content: string;
  components?: readonly APIMessageTopLevelComponent[];
  usesComponentsV2?: boolean;
}

function getRenderedPartChunks(renderedPart: RenderedDiscordPart): DiscordMessageChunk[] {
  const contentChunks = getContentChunks(renderedPart.content);

  if (renderedPart.components === undefined) {
    return contentChunks.map((content) => ({ content }));
  }

  if (contentChunks.length > 1) {
    throw new RuntimeError(
      'Interactive assistant replies must fit within a single Discord message.'
    );
  }

  const [content = ''] = contentChunks;

  return [
    {
      content,
      components: renderedPart.components,
      usesComponentsV2: renderedPart.usesComponentsV2,
    },
  ];
}

async function sendContentChunk(
  thread: AnyThreadChannel,
  chunk: DiscordMessageChunk
): Promise<Message<true>> {
  try {
    return await thread.send(
      chunk.usesComponentsV2
        ? {
            components: chunk.components,
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] },
          }
        : {
            content: chunk.content,
            components: chunk.components,
            allowedMentions: { parse: [] },
          }
    );
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
  chunk: DiscordMessageChunk
): Promise<Message<true>> {
  try {
    return await message.edit(
      chunk.usesComponentsV2
        ? {
            content: null,
            components: chunk.components ?? [],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] },
          }
        : {
            content: chunk.content,
            components: chunk.components ?? [],
            allowedMentions: { parse: [] },
          }
    );
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
  content: string,
  components?: readonly APIMessageTopLevelComponent[],
  usesComponentsV2?: boolean
): Promise<Message<true>[]> {
  const chunks = getRenderedPartChunks({
    id: 'standalone-reply',
    kind: 'text',
    label: 'Assistant',
    content,
    components,
    usesComponentsV2,
  });
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
  opencodeContext: OpencodeSdkContext,
  thread: AnyThreadChannel,
  part: AssistantOutputPart,
  previous?: SentDiscordPart
): Promise<SentDiscordPart | null> {
  assertThreadSendable(thread);
  await ensureThreadOpen(thread);

  if (part.type === 'step_start' || part.type === 'step_finish') {
    return null;
  }

  const renderedPart = await renderAssistantPart(opencodeContext, part);

  if (renderedPart === null) {
    return null;
  }

  if (previous === undefined) {
    const messages = await sendContentChunks(
      thread,
      renderedPart.content,
      renderedPart.components,
      renderedPart.usesComponentsV2
    );
    return { renderedPart, messages };
  }

  const nextChunks = getRenderedPartChunks(renderedPart);
  const updatedMessages: Message<true>[] = [];

  if (previous.renderedPart.components !== undefined || renderedPart.components !== undefined) {
    const [previousMessage] = previous.messages;
    const [nextChunk] = nextChunks;

    if (previousMessage === undefined || nextChunk === undefined) {
      throw new RuntimeError('Failed to reconcile an interactive assistant reply');
    }

    updatedMessages.push(await editContentChunk(thread, previousMessage, nextChunk));

    for (let index = 1; index < previous.messages.length; index += 1) {
      const previousMessageChunk = previous.messages[index];

      if (previousMessageChunk === undefined) {
        throw new RuntimeError('Failed to prune an interactive assistant reply');
      }

      await deleteContentChunk(thread, previousMessageChunk);
    }

    return {
      renderedPart,
      messages: updatedMessages,
    };
  }

  const sharedChunkCount = Math.min(previous.messages.length, nextChunks.length);

  for (let index = 0; index < sharedChunkCount; index += 1) {
    const previousMessage = previous.messages[index];
    const nextChunk = nextChunks[index];

    if (previousMessage === undefined || nextChunk === undefined) {
      throw new RuntimeError('Failed to reconcile assistant reply chunks');
    }

    if (previousMessage.content === nextChunk.content) {
      updatedMessages.push(previousMessage);
      continue;
    }

    updatedMessages.push(await editContentChunk(thread, previousMessage, nextChunk));
  }

  for (let index = sharedChunkCount; index < nextChunks.length; index += 1) {
    const nextChunk = nextChunks[index];

    if (nextChunk === undefined) {
      throw new RuntimeError('Failed to append assistant reply chunk');
    }

    updatedMessages.push(await sendContentChunk(thread, nextChunk));
  }

  for (let index = sharedChunkCount; index < previous.messages.length; index += 1) {
    const previousMessage = previous.messages[index];

    if (previousMessage === undefined) {
      throw new RuntimeError('Failed to prune assistant reply chunk');
    }

    await deleteContentChunk(thread, previousMessage);
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
  opencodeContext: OpencodeSdkContext,
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

      const sentPart = await upsertAssistantReplyPart(opencodeContext, thread, part);

      if (sentPart !== null) {
        sentParts.push(sentPart);
      }
    }
  } finally {
    typingSession.stop();
  }

  return sentParts;
}
