import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { RuntimeError, toError } from '../utils/errors';

export interface SqliteStatement<Row = unknown> {
  run(...parameters: readonly unknown[]): unknown;
  get(...parameters: readonly unknown[]): Row | undefined;
}

export interface ThreadSessionDatabase {
  pragma(source: string): unknown;
  exec(source: string): this;
  prepare<Row = unknown>(source: string): SqliteStatement<Row>;
  close(): void;
}

const BetterSqlite3 = require('better-sqlite3') as new (filename: string) => ThreadSessionDatabase;

const THREAD_SESSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS thread_sessions (
    thread_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL
  );
`;

function ensureDatabaseDirectory(databaseFilePath: string): void {
  if (databaseFilePath === ':memory:') {
    return;
  }

  mkdirSync(dirname(databaseFilePath), { recursive: true });
}

function configureDatabase(database: ThreadSessionDatabase): void {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
}

function createThreadSessionsTable(database: ThreadSessionDatabase): void {
  database.exec(THREAD_SESSIONS_SCHEMA);
}

export function initializeDatabase(databaseFilePath: string): ThreadSessionDatabase {
  let database: ThreadSessionDatabase | undefined;

  try {
    ensureDatabaseDirectory(databaseFilePath);
    database = new BetterSqlite3(databaseFilePath);
    configureDatabase(database);
    createThreadSessionsTable(database);

    return database;
  } catch (error) {
    database?.close();

    throw new RuntimeError(
      `Failed to initialize SQLite database at "${databaseFilePath}": ${toError(error).message}`,
    );
  }
}
