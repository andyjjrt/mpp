const MINIMUM_TIMEOUT_MS = 1;

const originalSetTimeout = globalThis.setTimeout.bind(globalThis);

Object.defineProperty(globalThis, 'setTimeout', {
  configurable: true,
  writable: true,
  value(
    handler: Parameters<typeof globalThis.setTimeout>[0],
    timeout?: number,
    ...arguments_: unknown[]
  ) {
    const normalizedTimeout =
      typeof timeout === 'number' ? Math.max(MINIMUM_TIMEOUT_MS, timeout) : timeout;

    return originalSetTimeout(handler, normalizedTimeout, ...arguments_);
  },
});
