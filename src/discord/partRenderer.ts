import type {
  AssistantErrorPart,
  AssistantOutputPart,
  AssistantPatchPart,
  AssistantReasoningPart,
  AssistantTextPart,
  AssistantToolCallPart,
  AssistantToolResultPart,
  AssistantUnknownPart,
} from '../opencode/parts';

export type RenderedDiscordPartKind =
  | 'text'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'unknown'
  | 'patch';

export interface RenderedDiscordPart {
  id: string;
  kind: RenderedDiscordPartKind;
  label: string;
  content: string;
}

const EMPTY_REASONING_FALLBACK = '_(assistant reasoning output was empty)_';

const EMPTY_ERROR_FALLBACK = '_(assistant reported an error without a message)_';
const UNKNOWN_PART_FALLBACK = 'Received an unsupported assistant output part.';

function hasVisibleText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function escapeCodeFence(value: string): string {
  return value.replaceAll('```', '`\u200b``');
}

function renderCodeBlock(language: string, value: string): string {
  return `\`\`\`${language}\n${escapeCodeFence(value)}\n\`\`\``;
}

function renderValue(value: unknown, emptyFallback: string): string {
  if (value === undefined) {
    return emptyFallback;
  }

  if (typeof value === 'string') {
    return hasVisibleText(value) ? renderCodeBlock('text', value) : emptyFallback;
  }

  const serializedValue = JSON.stringify(value, null, 2);

  if (!hasVisibleText(serializedValue)) {
    return emptyFallback;
  }

  return renderCodeBlock('json', serializedValue);
}

function createRenderedDiscordPart(
  part: Pick<AssistantOutputPart, 'id' | 'type'>,
  label: string,
  body: string,
  emptyFallback: string
): RenderedDiscordPart {
  const normalizedBody = hasVisibleText(body) ? body : emptyFallback;

  return {
    id: part.id,
    kind: part.type as RenderedDiscordPartKind,
    label,
    content: `**${label}**\n${normalizedBody}`,
  };
}

function renderTextPart(part: AssistantTextPart): RenderedDiscordPart | null {
  // Skip ignored or empty text parts
  if (part.ignored || !hasVisibleText(part.text)) {
    return null;
  }

  // Return plain text without "Assistant" label
  return {
    id: part.id,
    kind: 'text',
    label: 'Assistant',
    content: part.text,
  };
}

function renderReasoningPart(part: AssistantReasoningPart): RenderedDiscordPart {
  const text = hasVisibleText(part.text) ? part.text : EMPTY_REASONING_FALLBACK;
  // Format as blockquote: prepend > to each line
  const quotedText = text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return {
    id: part.id,
    kind: 'reasoning',
    label: 'Reasoning',
    content: quotedText,
  };
}

function renderToolCallPart(part: AssistantToolCallPart): RenderedDiscordPart {
  const timestamp = part.startTime ? ` (<t:${Math.floor(part.startTime / 1000)}:R>)` : '';
  const content = `> :wrench: **${part.tool}** ${part.title ?? ''}${timestamp}`;
  return {
    id: part.id,
    kind: 'tool_call',
    label: 'Tool call',
    content,
  };
}

function renderToolResultPart(part: AssistantToolResultPart): RenderedDiscordPart | null {
  // Skip tool results with no visible output
  if (!hasVisibleText(part.output)) {
    return null;
  }

  // Just show the output directly without metadata
  return {
    id: part.id,
    kind: 'tool_result',
    label: 'Tool result',
    content: part.output,
  };
}

function renderErrorPart(part: AssistantErrorPart): RenderedDiscordPart {
  const lines: string[] = [];

  lines.push(`Source: ${part.source}`);

  if (hasVisibleText(part.tool)) {
    lines.push(`Tool: ${part.tool}`);
  }

  if (hasVisibleText(part.callId)) {
    lines.push(`Call ID: ${part.callId}`);
  }

  if (hasVisibleText(part.name)) {
    lines.push(`Name: ${part.name}`);
  }

  lines.push(hasVisibleText(part.message) ? part.message : EMPTY_ERROR_FALLBACK);

  if (part.input !== undefined) {
    lines.push(`Input:\n${renderValue(part.input, '_(error input was empty)_')}`);
  }

  return createRenderedDiscordPart(part, 'Error', lines.join('\n'), EMPTY_ERROR_FALLBACK);
}

function renderUnknownPart(part: AssistantUnknownPart): RenderedDiscordPart {
  const lines = [UNKNOWN_PART_FALLBACK, `SDK part type: ${part.sdkPartType}`];

  if (hasVisibleText(part.summary)) {
    lines.push(part.summary.trim());
  }

  return createRenderedDiscordPart(
    part,
    'Unsupported assistant output',
    lines.join('\n'),
    UNKNOWN_PART_FALLBACK
  );
}

function renderPatchPart(part: AssistantPatchPart): RenderedDiscordPart {
  const fileList = part.files.join(', ');
  const content = `> :pencil: ${fileList}`;
  return {
    id: part.id,
    kind: 'patch' as RenderedDiscordPartKind,
    label: 'Patch',
    content,
  };
}

export function renderAssistantPart(part: AssistantOutputPart): RenderedDiscordPart | null {
  switch (part.type) {
    case 'text':
      return renderTextPart(part);
    case 'reasoning':
      return renderReasoningPart(part);
    case 'tool_call':
      return renderToolCallPart(part);
    case 'tool_result':
      return renderToolResultPart(part);
    case 'error':
      return renderErrorPart(part);
    case 'patch':
      return renderPatchPart(part);
    case 'unknown':
      return renderUnknownPart(part);
    case 'step_start':
    case 'step_finish':
      return null;
  }
}
