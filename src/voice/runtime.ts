import type { Guild, PublicThreadChannel, VoiceBasedChannel } from 'discord.js';

import { RuntimeError } from '../utils/errors.js';
import type { VoiceConnectionLike } from './transport.js';

export interface GuildVoiceSessionRef {
  id: string;
}

export interface GuildVoiceRecordingState {
  isActive: boolean;
}

export interface GuildVoiceRuntime extends VoiceRuntimeState {
  guild: Guild;
  thread: PublicThreadChannel<boolean>;
  session: GuildVoiceSessionRef;
  voiceChannel: VoiceBasedChannel;
  recording: GuildVoiceRecordingState;
}

export interface VoiceRuntimeState {
  guildId: string;
  threadId: string;
  sessionId: string;
  voiceChannelId: string;
  connection: VoiceConnectionLike;
  isRecording: boolean;
  guild?: Guild;
  thread?: PublicThreadChannel<boolean>;
  session?: GuildVoiceSessionRef;
  voiceChannel?: VoiceBasedChannel;
  recording: GuildVoiceRecordingState;
}

export interface SetVoiceRuntimeStateInput {
  guildId: string;
  threadId: string;
  sessionId: string;
  voiceChannelId: string;
  connection: VoiceConnectionLike;
  isRecording?: boolean;
}

export interface CreateGuildVoiceRuntimeInput {
  guild: Guild;
  thread: PublicThreadChannel<boolean>;
  session: GuildVoiceSessionRef;
  voiceChannel: VoiceBasedChannel;
  connection: VoiceConnectionLike;
  recording?: Partial<GuildVoiceRecordingState>;
}

export type SetVoiceRuntimeInput = SetVoiceRuntimeStateInput | CreateGuildVoiceRuntimeInput;

export interface GuildVoiceRuntimeStore {
  get(guildId: string): GuildVoiceRuntime | null;
  set(runtime: CreateGuildVoiceRuntimeInput): GuildVoiceRuntime;
  delete(guildId: string): GuildVoiceRuntime | null;
  entries(): IterableIterator<[string, GuildVoiceRuntime]>;
}

export interface VoiceRuntimeRegistry {
  getByGuildId(guildId: string): VoiceRuntimeState | null;
  getByThreadId(threadId: string): VoiceRuntimeState | null;
  get(guildId: string): VoiceRuntimeState | null;
  set(runtime: SetVoiceRuntimeInput): VoiceRuntimeState;
  removeByGuildId(guildId: string): VoiceRuntimeState | null;
  delete(guildId: string): VoiceRuntimeState | null;
  updateRecordingState(guildId: string, isRecording: boolean): VoiceRuntimeState;
  entries(): IterableIterator<[string, VoiceRuntimeState]>;
}

function requireIdentifier(
  name: 'guildId' | 'threadId' | 'sessionId' | 'voiceChannelId',
  value: string
): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new RuntimeError(`${name} must be a non-empty string`);
  }

  return normalizedValue;
}

function requireConnection(connection: VoiceConnectionLike): VoiceConnectionLike {
  if (typeof connection !== 'object' || connection === null) {
    throw new RuntimeError('connection must be provided');
  }

  return connection;
}

function requireObject<Value>(name: string, value: Value | null | undefined): Value {
  if (value === null || value === undefined || typeof value !== 'object') {
    throw new RuntimeError(`${name} must be provided`);
  }

  return value;
}

function isLegacyRuntimeInput(
  runtime: SetVoiceRuntimeInput
): runtime is CreateGuildVoiceRuntimeInput {
  return 'guild' in runtime;
}

function normalizeRuntimeState(runtime: SetVoiceRuntimeInput): VoiceRuntimeState {
  if (isLegacyRuntimeInput(runtime)) {
    const guild = requireObject('guild', runtime.guild);
    const thread = requireObject('thread', runtime.thread);
    const session = requireObject('session', runtime.session);
    const voiceChannel = requireObject('voiceChannel', runtime.voiceChannel);
    const connection = requireConnection(runtime.connection);
    const guildId = requireIdentifier('guildId', guild.id);
    const threadId = requireIdentifier('threadId', thread.id);
    const sessionId = requireIdentifier('sessionId', session.id);
    const voiceChannelId = requireIdentifier('voiceChannelId', voiceChannel.id);
    const isRecording = runtime.recording?.isActive ?? false;

    return {
      guildId,
      threadId,
      sessionId,
      voiceChannelId,
      connection,
      isRecording,
      guild,
      thread,
      session,
      voiceChannel,
      recording: {
        isActive: isRecording,
      },
    };
  }

  const isRecording = runtime.isRecording ?? false;

  return {
    guildId: requireIdentifier('guildId', runtime.guildId),
    threadId: requireIdentifier('threadId', runtime.threadId),
    sessionId: requireIdentifier('sessionId', runtime.sessionId),
    voiceChannelId: requireIdentifier('voiceChannelId', runtime.voiceChannelId),
    connection: requireConnection(runtime.connection),
    isRecording,
    recording: {
      isActive: isRecording,
    },
  };
}

function requireGuildVoiceRuntime(runtime: VoiceRuntimeState | null): GuildVoiceRuntime | null {
  if (runtime === null) {
    return null;
  }

  if (
    runtime.guild === undefined ||
    runtime.thread === undefined ||
    runtime.session === undefined ||
    runtime.voiceChannel === undefined
  ) {
    throw new RuntimeError('Guild voice runtime is missing managed Discord objects.');
  }

  return runtime as GuildVoiceRuntime;
}

function requireStoredGuildVoiceRuntime(runtime: VoiceRuntimeState): GuildVoiceRuntime {
  const guildVoiceRuntime = requireGuildVoiceRuntime(runtime);

  if (guildVoiceRuntime === null) {
    throw new RuntimeError('Guild voice runtime must exist.');
  }

  return guildVoiceRuntime;
}

export function createVoiceRuntimeRegistry(): VoiceRuntimeRegistry {
  const runtimesByGuildId = new Map<string, VoiceRuntimeState>();
  const guildIdByThreadId = new Map<string, string>();

  function removeStoredRuntime(guildId: string): VoiceRuntimeState | null {
    const storedRuntime = runtimesByGuildId.get(guildId);

    if (storedRuntime === undefined) {
      return null;
    }

    runtimesByGuildId.delete(guildId);
    guildIdByThreadId.delete(storedRuntime.threadId);

    return storedRuntime;
  }

  return {
    getByGuildId(guildId) {
      const normalizedGuildId = requireIdentifier('guildId', guildId);

      return runtimesByGuildId.get(normalizedGuildId) ?? null;
    },

    get(guildId) {
      return this.getByGuildId(guildId);
    },

    getByThreadId(threadId) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);
      const guildId = guildIdByThreadId.get(normalizedThreadId);

      if (guildId === undefined) {
        return null;
      }

      return runtimesByGuildId.get(guildId) ?? null;
    },

    set(runtime) {
      const normalizedRuntime = normalizeRuntimeState(runtime);
      const existingGuildIdForThread = guildIdByThreadId.get(normalizedRuntime.threadId);

      if (
        existingGuildIdForThread !== undefined &&
        existingGuildIdForThread !== normalizedRuntime.guildId
      ) {
        removeStoredRuntime(existingGuildIdForThread);
      }

      removeStoredRuntime(normalizedRuntime.guildId);

      runtimesByGuildId.set(normalizedRuntime.guildId, normalizedRuntime);
      guildIdByThreadId.set(normalizedRuntime.threadId, normalizedRuntime.guildId);

      return normalizedRuntime;
    },

    removeByGuildId(guildId) {
      const normalizedGuildId = requireIdentifier('guildId', guildId);

      return removeStoredRuntime(normalizedGuildId);
    },

    delete(guildId) {
      return this.removeByGuildId(guildId);
    },

    updateRecordingState(guildId, isRecording) {
      if (typeof isRecording !== 'boolean') {
        throw new RuntimeError('isRecording must be a boolean');
      }

      const normalizedGuildId = requireIdentifier('guildId', guildId);
      const runtime = runtimesByGuildId.get(normalizedGuildId);

      if (runtime === undefined) {
        throw new RuntimeError(
          `No active voice runtime exists for guild "${normalizedGuildId}".`,
          404
        );
      }

      const updatedRuntime: VoiceRuntimeState = {
        ...runtime,
        isRecording,
        recording: {
          isActive: isRecording,
        },
      };

      runtimesByGuildId.set(normalizedGuildId, updatedRuntime);

      return updatedRuntime;
    },

    entries() {
      return runtimesByGuildId.entries();
    },
  };
}

export const voiceRuntimes = createVoiceRuntimeRegistry();

export const guildVoiceRuntimes: GuildVoiceRuntimeStore = {
  get(guildId) {
    return requireGuildVoiceRuntime(voiceRuntimes.getByGuildId(guildId));
  },

  set(runtime) {
    return requireStoredGuildVoiceRuntime(voiceRuntimes.set(runtime));
  },

  delete(guildId) {
    return requireGuildVoiceRuntime(voiceRuntimes.removeByGuildId(guildId));
  },

  *entries() {
    for (const [guildId, runtime] of voiceRuntimes.entries()) {
      const guildVoiceRuntime = requireGuildVoiceRuntime(runtime);

      if (guildVoiceRuntime !== null) {
        yield [guildId, guildVoiceRuntime];
      }
    }
  },
};
