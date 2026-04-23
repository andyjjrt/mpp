import { RuntimeError, toError } from '../utils/errors.js';

import type { ThreadSessionDatabase } from './db.js';

interface ThreadSessionRow {
  session_id: string;
  model_provider_id: string | null;
  model_id: string | null;
  agent_name: string | null;
  first_user_id: string | null;
  mentionables_json: string | null;
}

export type ThreadModelPreference = { providerID: string; modelID: string };

export type ThreadPromptPreferences = { model: ThreadModelPreference | null; agent: string | null };

export interface ThreadSessionRepo {
  bind(threadId: string, sessionId: string): void;
  findSessionId(threadId: string): string | null;
  exists(threadId: string): boolean;
  findPromptPreferences(threadId: string): ThreadPromptPreferences;
  setModel(threadId: string, model: ThreadModelPreference | null): void;
  setAgent(threadId: string, agent: string | null): void;
  setFirstUserId(threadId: string, userId: string): void;
  findFirstUserId(threadId: string): string | null;
}

function requireIdentifier(name: 'threadId' | 'sessionId' | 'userId', value: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new RuntimeError(`${name} must be a non-empty string`);
  }

  return normalizedValue;
}

export function createThreadSessionRepo(database: ThreadSessionDatabase): ThreadSessionRepo {
  const bindStatement = database.prepare(
    `INSERT INTO thread_sessions (thread_id, session_id)
     VALUES (?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id`
  );
  const findSessionIdStatement = database.prepare<ThreadSessionRow>(
    'SELECT session_id FROM thread_sessions WHERE thread_id = ?'
  );
  const findFirstUserIdStatement = database.prepare<ThreadSessionRow>(
    'SELECT first_user_id FROM thread_sessions WHERE thread_id = ?'
  );
  const existsStatement = database.prepare<{ thread_id: string }>(
    'SELECT thread_id FROM thread_sessions WHERE thread_id = ?'
  );
  const findPreferencesStatement = database.prepare<ThreadSessionRow>(
    'SELECT model_provider_id, model_id, agent_name FROM thread_sessions WHERE thread_id = ?'
  );

  const setModelStatement = database.prepare(
    'UPDATE thread_sessions SET model_provider_id = ?, model_id = ? WHERE thread_id = ?'
  );
  const setFirstUserIdStatement = database.prepare(
    'UPDATE thread_sessions SET first_user_id = COALESCE(first_user_id, ?) WHERE thread_id = ?'
  );
  const setAgentStatement = database.prepare(
    'UPDATE thread_sessions SET agent_name = ? WHERE thread_id = ?'
  );

  return {
    bind(threadId, sessionId) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);
      const normalizedSessionId = requireIdentifier('sessionId', sessionId);

      try {
        bindStatement.run(normalizedThreadId, normalizedSessionId);
      } catch (error) {
        throw new RuntimeError(
          `Failed to bind thread "${normalizedThreadId}" to session "${normalizedSessionId}": ${toError(error).message}`
        );
      }
    },

    findSessionId(threadId) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);

      try {
        return findSessionIdStatement.get(normalizedThreadId)?.session_id ?? null;
      } catch (error) {
        throw new RuntimeError(
          `Failed to look up a session for thread "${normalizedThreadId}": ${toError(error).message}`
        );
      }
    },

    findFirstUserId(threadId) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);

      try {
        return findFirstUserIdStatement.get(normalizedThreadId)?.first_user_id ?? null;
      } catch (error) {
        throw new RuntimeError(
          `Failed to look up the first user for thread "${normalizedThreadId}": ${toError(error).message}`
        );
      }
    },

    exists(threadId) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);
      try {
        return existsStatement.get(normalizedThreadId) !== undefined;
      } catch (error) {
        throw new RuntimeError(
          `Failed to check whether thread "${normalizedThreadId}" is bound to a session: ${toError(error).message}`
        );
      }
    },
    findPromptPreferences(threadId) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);
      try {
        const row = findPreferencesStatement.get(normalizedThreadId);
        if (!row) {
          return { model: null, agent: null };
        }
        return {
          model:
            row.model_provider_id && row.model_id
              ? {
                  providerID: row.model_provider_id,
                  modelID: row.model_id,
                }
              : null,
          agent: row.agent_name,
        };
      } catch (error) {
        throw new RuntimeError(
          `Failed to find preferences for thread "${normalizedThreadId}": ${toError(error).message}`
        );
      }
    },

    setFirstUserId(threadId, userId) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);
      const normalizedUserId = requireIdentifier('userId', userId);

      try {
        setFirstUserIdStatement.run(normalizedUserId, normalizedThreadId);
      } catch (error) {
        throw new RuntimeError(
          `Failed to set the first user for thread "${normalizedThreadId}": ${toError(error).message}`
        );
      }
    },

    setModel(threadId, model) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);
      try {
        setModelStatement.run(
          model?.providerID ?? null,
          model?.modelID ?? null,
          normalizedThreadId
        );
      } catch (error) {
        throw new RuntimeError(
          `Failed to set model for thread "${normalizedThreadId}": ${toError(error).message}`
        );
      }
    },

    setAgent(threadId, agent) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);
      try {
        setAgentStatement.run(agent, normalizedThreadId);
      } catch (error) {
        throw new RuntimeError(
          `Failed to set agent for thread "${normalizedThreadId}": ${toError(error).message}`
        );
      }
    },
  };
}
