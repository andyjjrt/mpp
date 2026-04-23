import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { RuntimeError, toError } from '../utils/errors.js';

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

interface BetterSqliteStatement<Row = unknown> {
  run(...parameters: readonly unknown[]): unknown;
  get(...parameters: readonly unknown[]): Row | undefined;
}

interface BetterSqliteDatabase {
  exec(source: string): void;
  prepare<Row = unknown>(source: string): BetterSqliteStatement<Row>;
  pragma(source: string): unknown;
  close(): void;
}

const THREAD_SESSIONS_SCHEMA =
  'CREATE TABLE IF NOT EXISTS thread_sessions (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, first_user_id TEXT NULL, model_provider_id TEXT NULL, model_id TEXT NULL, agent_name TEXT NULL, mentionables_json TEXT NULL);';

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
  try {
    database.exec('ALTER TABLE thread_sessions ADD COLUMN mentionables_json TEXT NULL');
  } catch {
    /* ignore if already exists */
  }
}

class BetterSqliteThreadSessionDatabase implements ThreadSessionDatabase {
  public constructor(private readonly database: BetterSqliteDatabase) {}

  public pragma(source: string): unknown {
    return this.database.pragma(source);
  }

  public exec(source: string): this {
    this.database.exec(source);

    return this;
  }

  public prepare<Row = unknown>(source: string): SqliteStatement<Row> {
    const statement = this.database.prepare<Row>(source);

    return {
      run: (...parameters) => statement.run(...parameters),
      get: (...parameters) => statement.get(...parameters),
    };
  }

  public close(): void {
    this.database.close();
  }
}

export function initializeDatabase(databaseFilePath: string): ThreadSessionDatabase {
  let database: BetterSqliteThreadSessionDatabase | undefined;

  try {
    ensureDatabaseDirectory(databaseFilePath);
    database = new BetterSqliteThreadSessionDatabase(new Database(databaseFilePath));
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
