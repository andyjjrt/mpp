import { expect, test, describe, beforeEach, afterEach } from 'bun:test';
import { initializeDatabase } from '../../src/storage/db';
import { createThreadSessionRepo } from '../../src/storage/threadSessionRepo';
import { unlinkSync, existsSync } from 'node:fs';

describe('Database Schema & Repository Preferences', () => {
  const DB_PATH = ':memory:';
  let db: any;
  let repo: any;

  beforeEach(() => {
    db = initializeDatabase(DB_PATH);
    repo = createThreadSessionRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  test('should store and retrieve model preferences', () => {
    const threadId = 'thread-1';
    repo.bind(threadId, 'session-1');

    // Initially should be null
    expect(repo.findPromptPreferences(threadId)).toEqual({
      model: null,
      agent: null,
    });

    // Set model
    repo.setModel(threadId, { providerID: 'openai', modelID: 'gpt-4' });
    expect(repo.findPromptPreferences(threadId).model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4',
    });

    // Clear model
    repo.setModel(threadId, null);
    expect(repo.findPromptPreferences(threadId).model).toBeNull();
  });

  test('should store and retrieve agent preferences', () => {
    const threadId = 'thread-2';
    repo.bind(threadId, 'session-2');

    // Set agent
    repo.setAgent(threadId, 'hephaestus');
    expect(repo.findPromptPreferences(threadId).agent).toBe('hephaestus');

    // Clear agent
    repo.setAgent(threadId, null);
    expect(repo.findPromptPreferences(threadId).agent).toBeNull();
  });

  test('updates should not affect each other', () => {
    const threadId = 'thread-3';
    repo.bind(threadId, 'session-3');

    repo.setModel(threadId, { providerID: 'anthropic', modelID: 'claude-3' });
    repo.setAgent(threadId, 'oracle');

    expect(repo.findPromptPreferences(threadId)).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-3' },
      agent: 'oracle',
    });

    // Clear model, agent should remain
    repo.setModel(threadId, null);
    expect(repo.findPromptPreferences(threadId)).toEqual({
      model: null,
      agent: 'oracle',
    });

    // Set model again, clear agent
    repo.setModel(threadId, { providerID: 'google', modelID: 'gemini-1.5' });
    repo.setAgent(threadId, null);
    expect(repo.findPromptPreferences(threadId)).toEqual({
      model: { providerID: 'google', modelID: 'gemini-1.5' },
      agent: null,
    });
  });

  test('migration should work for existing database', () => {
    const PERSISTENT_DB = './test-migration.sqlite';
    if (existsSync(PERSISTENT_DB)) unlinkSync(PERSISTENT_DB);

    try {
      // 1. Create DB with old schema manually
      const BunDatabase = require('bun:sqlite').Database;
      const rawDb = new BunDatabase(PERSISTENT_DB);
      rawDb.exec(`
        CREATE TABLE thread_sessions (
          thread_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL
        );
      `);
      rawDb.close();

      // 2. Initialize through our code - should migrate
      const migratedDb = initializeDatabase(PERSISTENT_DB);
      const migratedRepo = createThreadSessionRepo(migratedDb);

      const threadId = 'migrated-thread';
      migratedRepo.bind(threadId, 'migrated-session');

      // Should not throw and return nulls
      expect(migratedRepo.findPromptPreferences(threadId)).toEqual({
        model: null,
        agent: null,
      });

      // Should be able to set values
      migratedRepo.setModel(threadId, { providerID: 'p1', modelID: 'm1' });
      expect(migratedRepo.findPromptPreferences(threadId).model).toEqual({
        providerID: 'p1',
        modelID: 'm1',
      });

      migratedDb.close();
    } finally {
      if (existsSync(PERSISTENT_DB)) unlinkSync(PERSISTENT_DB);
    }
  });
});
