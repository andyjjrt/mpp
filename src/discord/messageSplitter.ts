export const DISCORD_MESSAGE_LIMIT = 2000;

const PARAGRAPH_BREAK_PATTERN = /(?:\r?\n){2,}/g;
const NEWLINE_BREAK_PATTERN = /\r?\n/g;
const WHITESPACE_BREAK_PATTERN = /\s+/g;
const CODE_FENCE_MARKER = '```';
const CODE_FENCE_CLOSER = '\n```';

interface SplitChunkResult {
  chunk: string;
  consumedLength: number;
  openFence: string | null;
}

function findBreakIndex(source: string, maxLength: number, pattern: RegExp): number {
  let bestIndex = -1;
  let match: RegExpExecArray | null;

  pattern.lastIndex = 0;

  while ((match = pattern.exec(source)) !== null) {
    const matchEndIndex = match.index + match[0].length;

    if (matchEndIndex > maxLength) {
      break;
    }

    if (matchEndIndex > 0) {
      bestIndex = matchEndIndex;
    }

    if (match[0].length === 0) {
      break;
    }
  }

  return bestIndex;
}

function selectSplitIndex(source: string, maxLength: number): number {
  if (source.length <= maxLength) {
    return source.length;
  }

  const paragraphBreakIndex = findBreakIndex(source, maxLength, PARAGRAPH_BREAK_PATTERN);

  if (paragraphBreakIndex > 0) {
    return paragraphBreakIndex;
  }

  const newlineBreakIndex = findBreakIndex(source, maxLength, NEWLINE_BREAK_PATTERN);

  if (newlineBreakIndex > 0) {
    return newlineBreakIndex;
  }

  const whitespaceBreakIndex = findBreakIndex(source, maxLength, WHITESPACE_BREAK_PATTERN);

  if (whitespaceBreakIndex > 0) {
    return whitespaceBreakIndex;
  }

  return maxLength;
}

function isCodeFenceLine(line: string): boolean {
  return line.trimStart().startsWith(CODE_FENCE_MARKER);
}

function resolveOpenFence(source: string, initialFence: string | null): string | null {
  let openFence = initialFence;

  for (const line of source.split('\n')) {
    if (isCodeFenceLine(line)) {
      openFence = openFence === null ? CODE_FENCE_MARKER : null;
    }
  }

  return openFence;
}

function splitChunk(
  source: string,
  maxLength: number,
  initialFence: string | null
): SplitChunkResult {
  const prefix = initialFence === null ? '' : `${initialFence}\n`;
  let contentBudget = maxLength - prefix.length;

  if (contentBudget <= 0) {
    throw new Error(
      `Discord message limit ${maxLength} is too small to preserve the current code fence state.`
    );
  }

  let splitIndex = selectSplitIndex(source, contentBudget);
  let segment = source.slice(0, splitIndex);
  let openFence = resolveOpenFence(segment, initialFence);
  let suffix = openFence === null ? '' : CODE_FENCE_CLOSER;

  if (prefix.length + segment.length + suffix.length > maxLength) {
    contentBudget -= suffix.length;

    if (contentBudget <= 0) {
      throw new Error(
        `Discord message limit ${maxLength} is too small to preserve balanced code fences.`
      );
    }

    splitIndex = selectSplitIndex(source, contentBudget);
    segment = source.slice(0, splitIndex);
    openFence = resolveOpenFence(segment, initialFence);
    suffix = openFence === null ? '' : CODE_FENCE_CLOSER;
  }

  return {
    chunk: `${prefix}${segment}${suffix}`,
    consumedLength: splitIndex,
    openFence,
  };
}

export function splitDiscordMessage(
  content: string,
  maxLength: number = DISCORD_MESSAGE_LIMIT
): string[] {
  if (maxLength <= 0) {
    throw new Error('Discord message limit must be greater than zero.');
  }

  if (content.length <= maxLength) {
    return [content];
  }

  const chunks: string[] = [];
  let remainingContent = content;
  let openFence: string | null = null;

  while (remainingContent.length > 0) {
    const nextChunk = splitChunk(remainingContent, maxLength, openFence);

    if (nextChunk.consumedLength <= 0) {
      throw new Error('Failed to split Discord message content safely.');
    }

    chunks.push(nextChunk.chunk);
    remainingContent = remainingContent.slice(nextChunk.consumedLength);
    openFence = nextChunk.openFence;
  }

  return chunks;
}
