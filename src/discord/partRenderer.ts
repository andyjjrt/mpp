import type {
  AssistantErrorPart,
  AssistantOutputPart,
  AssistantReasoningPart,
  AssistantTextPart,
  AssistantToolCallPart,
  AssistantToolResultPart,
  AssistantUnknownPart,
} from '../opencode/parts';

export type RenderedDiscordPartKind = 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'error' | 'unknown';

export interface RenderedDiscordPart {
  id: string;
  kind: RenderedDiscordPartKind;
  label: string;
  content: string;
}

const EMPTY_TEXT_FALLBACK = '_(assistant text output was empty)_';
const EMPTY_REASONING_FALLBACK = '_(assistant reasoning output was empty)_';
const EMPTY_TOOL_CALL_FALLBACK = '_(assistant emitted a tool call with no visible details)_';
const EMPTY_TOOL_RESULT_FALLBACK = '_(tool execution finished without visible output)_';
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
  emptyFallback: string,
): RenderedDiscordPart {
  const normalizedBody = hasVisibleText(body) ? body : emptyFallback;

  return {
    id: part.id,
    kind: part.type,
    label,
    content: `**${label}**\n${normalizedBody}`,
  };
}

function renderTextPart(part: AssistantTextPart): RenderedDiscordPart {
  return createRenderedDiscordPart(part, 'Assistant', part.text, EMPTY_TEXT_FALLBACK);
}

function renderReasoningPart(part: AssistantReasoningPart): RenderedDiscordPart {
  return createRenderedDiscordPart(part, 'Reasoning', part.text, EMPTY_REASONING_FALLBACK);
}

function renderToolCallPart(part: AssistantToolCallPart): RenderedDiscordPart {
  const lines = [`Tool: ${part.tool}`, `Status: ${part.status}`];

  if (hasVisibleText(part.callId)) {
    lines.push(`Call ID: ${part.callId}`);
  }

  if (hasVisibleText(part.title)) {
    lines.push(`Title: ${part.title}`);
  }

  lines.push(`Input:\n${renderValue(part.input, '_(tool call input was empty)_')}`);

  return createRenderedDiscordPart(part, 'Tool call', lines.join('\n'), EMPTY_TOOL_CALL_FALLBACK);
}

function renderToolResultPart(part: AssistantToolResultPart): RenderedDiscordPart {
  const lines = [`Tool: ${part.tool}`];

  if (hasVisibleText(part.callId)) {
    lines.push(`Call ID: ${part.callId}`);
  }

  if (hasVisibleText(part.title)) {
    lines.push(`Title: ${part.title}`);
  }

  lines.push(`Result:\n${renderValue(part.output, EMPTY_TOOL_RESULT_FALLBACK)}`);

  if (part.attachments.length > 0) {
    lines.push(`Attachments: ${part.attachments.length}`);
  }

  return createRenderedDiscordPart(part, 'Tool result', lines.join('\n'), EMPTY_TOOL_RESULT_FALLBACK);
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

  return createRenderedDiscordPart(part, 'Unsupported assistant output', lines.join('\n'), UNKNOWN_PART_FALLBACK);
}

export function renderAssistantPart(part: AssistantOutputPart): RenderedDiscordPart {
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
    case 'unknown':
      return renderUnknownPart(part);
  }
}
