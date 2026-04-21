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

interface BunSqliteStatement<Row = unknown> {
  run(...parameters: readonly unknown[]): unknown;
  get(...parameters: readonly unknown[]): Row | null;
}

interface BunSqliteDatabase {
  exec(source: string): void;
  query<Row = unknown>(source: string): BunSqliteStatement<Row>;
  close(): void;
}

const { Database: BunDatabase } = require('bun:sqlite') as {
  Database: new (filename: string) => BunSqliteDatabase;
};

const THREAD_SESSIONS_SCHEMA =
  'CREATE TABLE IF NOT EXISTS thread_sessions (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, first_user_id TEXT NULL, model_provider_id TEXT NULL, model_id TEXT NULL, agent_name TEXT NULL);';

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
function migrateSchema(database: ThreadSessionDatabase): void {
  try {
    database.exec('ALTER TABLE thread_sessions ADD COLUMN first_user_id TEXT NULL');
  } catch {
    /* ignore if already exists */
  }
  try {
    database.exec('ALTER TABLE thread_sessions ADD COLUMN model_provider_id TEXT NULL');
  } catch {
    /* ignore if already exists */
  }
  try {
    database.exec('ALTER TABLE thread_sessions ADD COLUMN model_id TEXT NULL');
  } catch {
    /* ignore if already exists */
  }
  try {
    database.exec('ALTER TABLE thread_sessions ADD COLUMN agent_name TEXT NULL');
  } catch {
    /* ignore if already exists */
  }
}

class BunThreadSessionDatabase implements ThreadSessionDatabase {
  public constructor(private readonly database: BunSqliteDatabase) {}

  public pragma(source: string): unknown {
    this.database.exec('PRAGMA ' + source);
    return undefined;
  }

  public exec(source: string): this {
    this.database.exec(source);

    return this;
  }

  public prepare<Row = unknown>(source: string): SqliteStatement<Row> {
    const statement = this.database.query<Row>(source);

    return {
      run: (...parameters) => statement.run(...parameters),
      get: (...parameters) => statement.get(...parameters) ?? undefined,
    };
  }

  public close(): void {
    this.database.close();
  }
}

export function initializeDatabase(databaseFilePath: string): ThreadSessionDatabase {
  let database: BunThreadSessionDatabase | undefined;

  try {
    ensureDatabaseDirectory(databaseFilePath);
    database = new BunThreadSessionDatabase(new BunDatabase(databaseFilePath));
    configureDatabase(database);
    createThreadSessionsTable(database);
    migrateSchema(database);

    return database;
  } catch (error) {
    database?.close();

    throw new RuntimeError(
      'Failed to initialize SQLite database at "' +
        databaseFilePath +
        '": ' +
        toError(error).message
    );
  }
}
