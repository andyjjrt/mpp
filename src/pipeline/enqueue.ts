import { RuntimeError } from '../utils/errors.js';

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

    queue.size += 1;
    queue.tail = currentTail;
    queues.set(normalizedThreadId, queue);

    try {
      await previousTail;
      return await task();
    } finally {
      releaseCurrentTail();
      queue.size -= 1;

      if (queue.size === 0 && queues.get(normalizedThreadId) === queue) {
        queues.delete(normalizedThreadId);
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
