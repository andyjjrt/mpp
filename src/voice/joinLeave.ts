import { joinVoiceChannel } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';

import {
  assertBoundManagedSessionThread,
  assertManagedSessionThread,
  type ManagedSessionThreadContext,
} from '../discord/threadGuards.js';
import { RuntimeError } from '../utils/errors.js';
import { stopGuildVoiceReceiver } from './receiver.js';
import { guildVoiceRuntimes } from './runtime.js';
import type { ThreadSessionRepo } from '../storage/threadSessionRepo.js';

export interface JoinGuildVoiceRuntimeDependencies {
  threadSessionRepo: ThreadSessionRepo;
}

export interface LeaveGuildVoiceRuntimeDependencies {
  threadSessionRepo: ThreadSessionRepo;
}

export interface JoinGuildVoiceRuntimeOptions {
  context: ManagedSessionThreadContext;
  userId: string;
}

export interface LeaveGuildVoiceRuntimeOptions {
  context: ManagedSessionThreadContext;
}

export interface JoinGuildVoiceRuntimeResult {
  status: 'joined';
  message: string;
  guildId: string;
  threadId: string;
  sessionId: string;
  voiceChannelId: string;
}

export interface LeaveGuildVoiceRuntimeResult {
  status: 'left';
  message: string;
  guildId: string;
  threadId: string;
  sessionId: string;
  voiceChannelId: string;
}

function requireUserId(userId: string): string {
  const normalizedUserId = userId.trim();

  if (normalizedUserId.length === 0) {
    throw new RuntimeError('userId must be a non-empty string');
  }

  return normalizedUserId;
}

function isVoiceBasedChannel(channel: unknown): channel is VoiceBasedChannel {
  return (
    typeof channel === 'object' &&
    channel !== null &&
    'isVoiceBased' in channel &&
    typeof channel.isVoiceBased === 'function' &&
    channel.isVoiceBased()
  );
}

async function resolveUserVoiceChannel(
  thread: ReturnType<typeof assertManagedSessionThread>,
  userId: string
): Promise<VoiceBasedChannel> {
  const voiceState = await thread.guild.voiceStates.fetch(requireUserId(userId));
  const voiceChannel = voiceState.channel;

  if (!isVoiceBasedChannel(voiceChannel)) {
    throw new RuntimeError('Join a voice channel first.', 400);
  }

  return voiceChannel;
}

export async function joinGuildVoiceRuntime(
  dependencies: JoinGuildVoiceRuntimeDependencies,
  options: JoinGuildVoiceRuntimeOptions
): Promise<JoinGuildVoiceRuntimeResult> {
  const { sessionId, thread } = assertBoundManagedSessionThread(
    dependencies.threadSessionRepo,
    options.context
  );
  const existingRuntime = guildVoiceRuntimes.get(thread.guild.id);

  if (existingRuntime !== null) {
    throw new RuntimeError('A voice session is already active in this guild.', 409);
  }

  const voiceChannel = await resolveUserVoiceChannel(thread, options.userId);

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: thread.guild.id,
      adapterCreator: thread.guild.voiceAdapterCreator,
    });

    guildVoiceRuntimes.set({
      guild: thread.guild,
      thread,
      session: { id: sessionId },
      voiceChannel,
      connection,
      recording: {
        isActive: false,
      },
    });
  } catch {
    throw new RuntimeError('Failed to join the voice channel.');
  }

  return {
    status: 'joined',
    message: 'Joined the voice channel.',
    guildId: thread.guild.id,
    threadId: thread.id,
    sessionId,
    voiceChannelId: voiceChannel.id,
  };
}

export async function leaveGuildVoiceRuntime(
  dependencies: LeaveGuildVoiceRuntimeDependencies,
  options: LeaveGuildVoiceRuntimeOptions
): Promise<LeaveGuildVoiceRuntimeResult> {
  const { sessionId, thread } = assertBoundManagedSessionThread(
    dependencies.threadSessionRepo,
    options.context
  );
  const runtime = guildVoiceRuntimes.get(thread.guild.id);

  if (runtime === null || runtime.thread.id !== thread.id) {
    throw new RuntimeError('No active voice session for this thread.', 404);
  }

  let destroyError: RuntimeError | null = null;

  try {
    stopGuildVoiceReceiver(thread.guild.id);
    runtime.connection.destroy();
  } catch {
    destroyError = new RuntimeError('Failed to leave the voice channel.');
  } finally {
    guildVoiceRuntimes.delete(thread.guild.id);
  }

  if (destroyError !== null) {
    throw destroyError;
  }

  return {
    status: 'left',
    message: 'Left the voice channel.',
    guildId: thread.guild.id,
    threadId: thread.id,
    sessionId,
    voiceChannelId: runtime.voiceChannel.id,
  };
}
