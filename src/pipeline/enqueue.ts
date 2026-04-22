import { RuntimeError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ module: 'enqueue' });

export interface ThreadTaskQueue {
  enqueue<Result>(threadId: string, task: () => Promise<Result>): Promise<Result>;
  hasPending(threadId: string): boolean;
}

interface ThreadQueueState {
  tail: Promise<void>;
  size: number;
}

function requireThreadId(threadId: string): string {
  const normalizedThreadId = threadId.trim();

  if (normalizedThreadId.length === 0) {
    throw new RuntimeError('threadId must be a non-empty string');
  }

  return normalizedThreadId;
}

export function createThreadTaskQueue(): ThreadTaskQueue {
  const queues = new Map<string, ThreadQueueState>();

  async function enqueue<Result>(threadId: string, task: () => Promise<Result>): Promise<Result> {
    const normalizedThreadId = requireThreadId(threadId);
    const queue =
      queues.get(normalizedThreadId) ??
      ({
        tail: Promise.resolve(),
        size: 0,
      } satisfies ThreadQueueState);
    const previousTail = queue.tail.catch(() => undefined);
    let releaseCurrentTail!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      releaseCurrentTail = resolve;
    });

    const previousSize = queue.size;
    queue.size += 1;
    queue.tail = currentTail;
    queues.set(normalizedThreadId, queue);

    const enqueueTime = Date.now();
    logger.debug(
      { threadId: normalizedThreadId, queueSize: queue.size, previousSize },
      'Queue task enqueued'
    );

    try {
      const waitStart = Date.now();
      await previousTail;
      const waitDuration = Date.now() - waitStart;
      if (waitDuration > 100) {
        logger.debug(
          { threadId: normalizedThreadId, waitDurationMs: waitDuration, previousSize },
          'Queue waited for previous task'
        );
      }
      const taskStart = Date.now();
      const result = await task();
      const taskDuration = Date.now() - taskStart;
      logger.debug(
        {
          threadId: normalizedThreadId,
          taskDurationMs: taskDuration,
          totalDurationMs: Date.now() - enqueueTime,
        },
        'Queue task completed'
      );
      return result;
    } finally {
      releaseCurrentTail();
      queue.size -= 1;

      if (queue.size === 0 && queues.get(normalizedThreadId) === queue) {
        queues.delete(normalizedThreadId);
        logger.debug(
          { threadId: normalizedThreadId, totalDurationMs: Date.now() - enqueueTime },
          'Queue emptied'
        );
      }
    }
  }

  function hasPending(threadId: string): boolean {
    return queues.has(requireThreadId(threadId));
  }

  return {
    enqueue,
    hasPending,
  };
}
