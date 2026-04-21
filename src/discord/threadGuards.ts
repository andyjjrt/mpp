import { ChannelType } from 'discord.js';

import type { AnyThreadChannel, BaseInteraction, Message, PublicThreadChannel } from 'discord.js';

import { RuntimeError } from '../utils/errors';

export type ManagedSessionThreadContext =
  | AnyThreadChannel
  | Pick<BaseInteraction, 'channel'>
  | Pick<Message, 'channel'>
  | null
  | undefined;

function isThreadChannel(channel: unknown): channel is AnyThreadChannel {
  return (
    typeof channel === 'object'
    && channel !== null
    && 'isThread' in channel
    && typeof channel.isThread === 'function'
    && channel.isThread()
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

export function isThreadMessage(message: Message): message is Message<true> & { channel: AnyThreadChannel } {
  return isThreadChannel(message.channel);
}

export function assertManagedSessionThread(context: ManagedSessionThreadContext): PublicThreadChannel<boolean> {
  const channel = resolveChannel(context);

  if (!isThreadChannel(channel) || channel.type !== ChannelType.PublicThread) {
    throw new RuntimeError('This action must be used inside a managed session thread.', 400);
  }

  return channel;
}
