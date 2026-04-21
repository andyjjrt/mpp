import { RuntimeError, toError } from '../utils/errors';

import type { ThreadSessionDatabase } from './db';

interface ThreadSessionRow {
  session_id: string;
}

export interface ThreadSessionRepo {
  bind(threadId: string, sessionId: string): void;
  findSessionId(threadId: string): string | null;
  exists(threadId: string): boolean;
}

function requireIdentifier(name: 'threadId' | 'sessionId', value: string): string {
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
     ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id`,
  );
  const findSessionIdStatement = database.prepare<ThreadSessionRow>(
    'SELECT session_id FROM thread_sessions WHERE thread_id = ?',
  );
  const existsStatement = database.prepare<{ thread_id: string }>(
    'SELECT thread_id FROM thread_sessions WHERE thread_id = ?',
  );

  return {
    bind(threadId, sessionId) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);
      const normalizedSessionId = requireIdentifier('sessionId', sessionId);

      try {
        bindStatement.run(normalizedThreadId, normalizedSessionId);
      } catch (error) {
        throw new RuntimeError(
          `Failed to bind thread "${normalizedThreadId}" to session "${normalizedSessionId}": ${toError(error).message}`,
        );
      }
    },

    findSessionId(threadId) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);

      try {
        return findSessionIdStatement.get(normalizedThreadId)?.session_id ?? null;
      } catch (error) {
        throw new RuntimeError(
          `Failed to look up a session for thread "${normalizedThreadId}": ${toError(error).message}`,
        );
      }
    },

    exists(threadId) {
      const normalizedThreadId = requireIdentifier('threadId', threadId);

      try {
        return existsStatement.get(normalizedThreadId) !== undefined;
      } catch (error) {
        throw new RuntimeError(
          `Failed to check whether thread "${normalizedThreadId}" is bound to a session: ${toError(error).message}`,
        );
      }
    },
  };
}
