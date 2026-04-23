import { Events, type AnyThreadChannel, type Client, type Message } from 'discord.js';

import { sendRepliesToThread } from '../../discord/replies.js';
import { isThreadMessage } from '../../discord/threadGuards.js';
import type { OpencodeSdkContext } from '../../opencode/sdk.js';
import type { HandleThreadMessageResult } from '../../pipeline/handleThreadMessage.js';
import { handleThreadMessage } from '../../pipeline/handleThreadMessage.js';
import type { ThreadTaskQueue } from '../../pipeline/enqueue.js';
import type { ThreadSessionRepo } from '../../storage/threadSessionRepo.js';
import type { AppConfig } from '../../types.js';
import { toError } from '../../utils/errors.js';
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

function isBotAuthoredMessage(message: Message): boolean {
  return message.author.bot || message.webhookId !== null;
}

function isIgnoredMessage(message: Message): boolean {
  return message.content.trimStart().startsWith('!');
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

void sendMessageErrorReply;

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
  firstUserId?: string,
  enableCompletionMention?: boolean,
  enableCompletionReport?: boolean
): Promise<HandleThreadMessageResult> {
  const result = await services.threadTaskQueue.enqueue(thread.id, async () =>
    handleThreadMessage(
      {
        opencode: services.opencodeContext,
        threadSessionRepo: services.threadSessionRepo,
        enableCompletionMention: enableCompletionMention ?? false,
        enableCompletionReport: enableCompletionReport ?? false,
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
  message: Message<true> & { channel: AnyThreadChannel },
  enableCompletionMention: boolean,
  enableCompletionReport: boolean
): Promise<void> {
  if (!services.threadSessionRepo.exists(message.channel.id)) {
    return;
  }

  try {
    await enqueueThreadPrompt(
      services,
      message,
      message.channel,
      message.content,
      undefined,
      enableCompletionMention,
      enableCompletionReport
    );
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

async function handleDiscordMessage(
  _client: Client,
  config: AppConfig,
  services: MessageCreateServices,
  message: Message
): Promise<void> {
  if (isBotAuthoredMessage(message) || !message.inGuild()) {
    return;
  }

  if (isIgnoredMessage(message)) {
    return;
  }

  const resolvedMessage = message.partial ? await message.fetch() : message;
  const cachedMessage = resolvedMessage as Message<true>;

  if (isThreadMessage(cachedMessage)) {
    await handleManagedThreadMessage(
      services,
      cachedMessage,
      config.enableCompletionMention,
      config.enableCompletionReport
    );
    return;
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
