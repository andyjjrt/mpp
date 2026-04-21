import { ChannelType } from 'discord.js';

import type { AnyThreadChannel, BaseInteraction, Message, PublicThreadChannel } from 'discord.js';

import type { ThreadSessionRepo } from '../storage/threadSessionRepo.js';
import { RuntimeError } from '../utils/errors.js';

export type ManagedSessionThreadContext =
  | AnyThreadChannel
  | Pick<BaseInteraction, 'channel'>
  | Pick<Message, 'channel'>
  | null
  | undefined;

function isThreadChannel(channel: unknown): channel is AnyThreadChannel {
  return (
    typeof channel === 'object' &&
    channel !== null &&
    'isThread' in channel &&
    typeof channel.isThread === 'function' &&
    channel.isThread()
  );
}

function resolveChannel(context: ManagedSessionThreadContext): unknown {
  if (context === null || context === undefined) {
    return null;
  }

  if (typeof context === 'object' && 'channel' in context) {
    return context.channel;
  }

  return context;
}

export function isThreadMessage(
  message: Message
): message is Message<true> & { channel: AnyThreadChannel } {
  return isThreadChannel(message.channel);
}

export function assertManagedSessionThread(
  context: ManagedSessionThreadContext
): PublicThreadChannel<boolean> {
  const channel = resolveChannel(context);

  if (!isThreadChannel(channel) || channel.type !== ChannelType.PublicThread) {
    throw new RuntimeError('This action must be used inside a managed session thread.', 400);
  }

  return channel;
}

export function assertBoundManagedSessionThread(
  threadSessionRepo: ThreadSessionRepo,
  context: ManagedSessionThreadContext
): { thread: PublicThreadChannel<boolean>; sessionId: string } {
  const thread = assertManagedSessionThread(context);
  const sessionId = threadSessionRepo.findSessionId(thread.id);

  if (sessionId === null) {
    throw new RuntimeError('This action must be used inside a managed session thread.', 400);
  }

  return {
    thread,
    sessionId,
  };
}
