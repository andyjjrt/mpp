import type { AnyThreadChannel, Message, PublicThreadChannel } from 'discord.js';

import { RuntimeError, toError } from '../utils/errors.js';

const DISCORD_THREAD_TITLE_MAX_LENGTH = 100;
const DISCORD_MESSAGE_CONTENT_MAX_LENGTH = 2_000;

function requireNonEmptyString(name: 'title' | 'content', value: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new RuntimeError(`${name} must be a non-empty string`, 400);
  }

  return value;
}

function normalizeThreadTitle(title: string): string {
  return requireNonEmptyString('title', title).trim().slice(0, DISCORD_THREAD_TITLE_MAX_LENGTH);
}

function validateReplyContent(content: string): string {
  requireNonEmptyString('content', content);

  if (content.length > DISCORD_MESSAGE_CONTENT_MAX_LENGTH) {
    throw new RuntimeError(
      `content must be ${DISCORD_MESSAGE_CONTENT_MAX_LENGTH} characters or fewer`,
      400
    );
  }

  return content;
}

export async function createSessionThreadFromMessage(
  message: Message<true>,
  title: string
): Promise<PublicThreadChannel<false>> {
  const normalizedTitle = normalizeThreadTitle(title);

  try {
    return await message.startThread({ name: normalizedTitle });
  } catch (error) {
    throw new RuntimeError(
      `Failed to create session thread "${normalizedTitle}" from message "${message.id}": ${toError(error).message}`
    );
  }
}

export async function replyInThread(
  thread: AnyThreadChannel,
  content: string
): Promise<Message<true>> {
  const validatedContent = validateReplyContent(content);

  try {
    return await thread.send(validatedContent);
  } catch (error) {
    throw new RuntimeError(
      `Failed to send a reply in thread "${thread.id}": ${toError(error).message}`
    );
  }
}
