export function now(): Date {
  return new Date();
}

export function toIsoTimestamp(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

export function elapsedMilliseconds(
  startedAt: Date | number,
  finishedAt: Date | number = Date.now()
): number {
  const start = startedAt instanceof Date ? startedAt.getTime() : startedAt;
  const finish = finishedAt instanceof Date ? finishedAt.getTime() : finishedAt;

  return finish - start;
}
