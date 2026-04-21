import { Events, type AnyThreadChannel, type Client, type Message } from 'discord.js';

import { sendRepliesToThread } from '../../discord/replies.js';
import { createSessionThreadFromMessage } from '../../discord/sessionThreads.js';
import { isThreadMessage } from '../../discord/threadGuards.js';
import type { OpencodeSdkContext } from '../../opencode/sdk.js';
import type { HandleThreadMessageResult } from '../../pipeline/handleThreadMessage.js';
import { handleThreadMessage } from '../../pipeline/handleThreadMessage.js';
import type { ThreadTaskQueue } from '../../pipeline/enqueue.js';
import type { ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import type { AppConfig } from '../../types.js';
import { RuntimeError, toError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ module: 'app' });

interface MessageCreateServices {
  opencodeContext: OpencodeSdkContext;
  threadSessionRepo: ThreadSessionRepo;
  threadTaskQueue: ThreadTaskQueue;
}

export interface RegisterMessageCreateHandlerOptions {
  config: AppConfig;
  services: MessageCreateServices;
}

function normalizeMentionPrompt(message: Message, botUserId: string): string {
  return message.content.replace(new RegExp(`<@!?${botUserId}>`, 'gu'), '').trim();
}

function resolveThreadTitle(message: Message, prompt: string): string {
  const normalizedPrompt = prompt.trim();

  if (normalizedPrompt.length > 0) {
    return normalizedPrompt;
  }

  const normalizedFallback = message.cleanContent.trim();
  return normalizedFallback.length > 0 ? normalizedFallback : `Session ${message.id}`;
}

function isBotAuthoredMessage(message: Message): boolean {
  return message.author.bot || message.webhookId !== null;
}

async function resolveSessionThreadFromMessage(
  message: Message<true>,
  title: string
): Promise<AnyThreadChannel> {
  if (message.hasThread && message.thread !== null) {
    return message.thread;
  }

  return createSessionThreadFromMessage(message, title);
}

async function sendMessageErrorReply(message: Message, error: Error): Promise<void> {
  try {
    await message.reply({
      content: `**Error**\n${error.message}`,
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
    });
  } catch (replyError) {
    logger.error(
      {
        err: toError(replyError),
        messageId: message.id,
        channelId: message.channelId,
      },
      'Failed to send an error reply for a Discord message'
    );
  }
}

async function sendThreadErrorReply(thread: AnyThreadChannel, error: Error): Promise<void> {
  try {
    await sendRepliesToThread(thread, `**Error**\n${error.message}`);
  } catch (replyError) {
    logger.error(
      {
        err: toError(replyError),
        threadId: thread.id,
      },
      'Failed to send an error reply in a managed session thread'
    );
  }
}

async function enqueueThreadPrompt(
  services: MessageCreateServices,
  sourceMessage: Message<true>,
  thread: AnyThreadChannel,
  text: string,
  firstUserId?: string
): Promise<HandleThreadMessageResult> {
  const result = await services.threadTaskQueue.enqueue(thread.id, async () =>
    handleThreadMessage(
      {
        opencode: services.opencodeContext,
        threadSessionRepo: services.threadSessionRepo,
      },
      {
        thread,
        text,
        firstUserId,
      }
    )
  );

  logger.info(
    {
      messageId: sourceMessage.id,
      threadId: thread.id,
      sessionId: result.sessionId,
      createdSession: result.createdSession,
      assistantPartCount: result.promptResult.parts.length,
      terminalEvent: result.promptResult.terminalEvent,
      queuePending: services.threadTaskQueue.hasPending(thread.id),
    },
    'Processed serialized text prompt for a managed thread'
  );

  return result;
}

async function handleManagedThreadMessage(
  services: MessageCreateServices,
  message: Message<true> & { channel: AnyThreadChannel }
): Promise<void> {
  if (!services.threadSessionRepo.exists(message.channel.id)) {
    return;
  }

  try {
    await enqueueThreadPrompt(services, message, message.channel, message.content);
  } catch (error) {
    const runtimeError = toError(error);

    logger.error(
      {
        err: runtimeError,
        messageId: message.id,
        threadId: message.channel.id,
      },
      'Failed to process a managed thread message'
    );

    await sendThreadErrorReply(message.channel, runtimeError);
  }
}

async function handleMentionMessage(
  client: Client,
  config: AppConfig,
  services: MessageCreateServices,
  message: Message<true>
): Promise<void> {
  const botUserId = client.user?.id;

  if (botUserId === undefined || !message.mentions.users.has(botUserId)) {
    return;
  }

  const prompt = normalizeMentionPrompt(message, botUserId);

  if (prompt.length === 0) {
    throw new RuntimeError('Mention prompt must include text content.', 400);
  }

  const threadTitle = resolveThreadTitle(message, prompt);
  const createdThread = !message.hasThread;
  const thread = await resolveSessionThreadFromMessage(message, threadTitle);

  try {
    await enqueueThreadPrompt(
      services,
      message,
      thread,
      prompt,
      createdThread ? message.author.id : undefined
    );

    if (createdThread) {
      services.threadSessionRepo.setFirstUserId(thread.id, message.author.id);
    }
  } catch (error) {
    const runtimeError = toError(error);

    if (createdThread && services.threadSessionRepo.exists(thread.id)) {
      services.threadSessionRepo.setFirstUserId(thread.id, message.author.id);
    }

    logger.error(
      {
        err: runtimeError,
        messageId: message.id,
        threadId: thread.id,
        monitoredChannelId: config.discord.monitoredChannelId,
      },
      'Failed to process a monitored-channel mention'
    );

    await sendThreadErrorReply(thread, runtimeError);
  }
}

async function handleDiscordMessage(
  client: Client,
  config: AppConfig,
  services: MessageCreateServices,
  message: Message
): Promise<void> {
  if (isBotAuthoredMessage(message) || !message.inGuild()) {
    return;
  }

  const resolvedMessage = message.partial ? await message.fetch() : message;
  const cachedMessage = resolvedMessage as Message<true>;

  if (isThreadMessage(cachedMessage)) {
    await handleManagedThreadMessage(services, cachedMessage);
    return;
  }

  if (cachedMessage.channelId !== config.discord.monitoredChannelId) {
    return;
  }

  try {
    await handleMentionMessage(client, config, services, cachedMessage);
  } catch (error) {
    const runtimeError = toError(error);

    logger.error(
      {
        err: runtimeError,
        messageId: cachedMessage.id,
        channelId: cachedMessage.channelId,
        monitoredChannelId: config.discord.monitoredChannelId,
      },
      'Failed to prepare a monitored-channel mention for processing'
    );

    await sendMessageErrorReply(cachedMessage, runtimeError);
  }
}

export function registerMessageCreateHandler(
  client: Client,
  options: RegisterMessageCreateHandlerOptions
): void {
  client.on(Events.MessageCreate, (message) => {
    void handleDiscordMessage(client, options.config, options.services, message);
  });
}
