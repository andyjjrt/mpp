import type {
  APIComponentInContainer,
  APIMessageTopLevelComponent,
  APISectionComponent,
  APITextDisplayComponent,
} from 'discord-api-types/v10';
import {
  ButtonStyle,
  ComponentType,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputStyle,
} from 'discord.js';

import {
  parseAssistantQuestionToolCall,
  type AssistantQuestionInfo,
  type AssistantToolCallPart,
} from '../opencode/parts.js';
import type { OpencodeSdkContext } from '../opencode/sdk.js';
import type { RenderedDiscordPart } from './partRenderer.js';

const QUESTION_SELECT_CUSTOM_ID_PREFIX = 'mpp-question-select';
const QUESTION_OTHER_CUSTOM_ID_PREFIX = 'mpp-question-other';
const QUESTION_OPTION_CUSTOM_ID_PREFIX = 'mpp-question-option';
const QUESTION_MODAL_CUSTOM_ID_PREFIX = 'mpp-question-modal';
export const QUESTION_CUSTOM_ANSWER_FIELD_ID = 'answer';
const MAX_SELECT_OPTIONS = 25;

export interface QuestionSelectCustomId {
  sessionId: string;
  toolCallId: string;
  questionIndex: number;
}

export interface QuestionOtherCustomId {
  sessionId: string;
  toolCallId: string;
  questionIndex: number;
}

export interface QuestionOptionCustomId {
  sessionId: string;
  toolCallId: string;
  questionIndex: number;
  optionIndex: number;
}

export interface QuestionModalCustomId {
  sessionId: string;
  toolCallId: string;
  questionIndex: number;
  messageId: string;
}

function encodeCustomIdPart(value: string): string {
  return encodeURIComponent(value);
}

function decodeCustomIdPart(value: string): string | null {
  try {
    const decodedValue = decodeURIComponent(value).trim();
    return decodedValue.length > 0 ? decodedValue : null;
  } catch {
    return null;
  }
}

function parseCustomId(customId: string, prefix: string, partCount: number): string[] | null {
  const segments = customId.split(':');

  if (segments[0] !== prefix || segments.length !== partCount + 1) {
    return null;
  }

  const decodedSegments = segments.slice(1).map((segment) => decodeCustomIdPart(segment));

  return decodedSegments.every((segment) => segment !== null) ? decodedSegments : null;
}

function escapeInlineCode(value: string): string {
  return value.replaceAll('`', '\\`');
}

function createTextDisplay(content: string): APITextDisplayComponent {
  return {
    type: ComponentType.TextDisplay,
    content,
  };
}

function createQuestionPromptText(
  question: AssistantQuestionInfo,
  questionNumber?: number
): string {
  const selectionHint = question.multiple
    ? 'Select one or more answers below, or choose **Other answer**.'
    : 'Choose one of the options below, or choose **Other answer**.';

  const prefix = questionNumber !== undefined ? `**Question ${questionNumber}**\n` : '';

  return `${prefix}**${question.header}**\n${question.question}\n\n${selectionHint}`;
}

function createQuestionOptionSection(
  sessionId: string,
  toolCallId: string,
  questionIndex: number,
  optionIndex: number,
  option: AssistantQuestionInfo['options'][number]
): APISectionComponent {
  return {
    type: ComponentType.Section,
    components: [createTextDisplay(`**${option.label}**\n${option.description}`)],
    accessory: {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: option.label,
      custom_id: createQuestionOptionCustomId(sessionId, toolCallId, questionIndex, optionIndex),
    },
  };
}

function createOtherAnswerSection(
  sessionId: string,
  toolCallId: string,
  questionIndex: number
): APISectionComponent {
  return {
    type: ComponentType.Section,
    components: [
      createTextDisplay(
        '**Other answer**\nType a custom answer instead of choosing one of the listed options.'
      ),
    ],
    accessory: {
      type: ComponentType.Button,
      style: ButtonStyle.Primary,
      label: 'Type answer',
      custom_id: createQuestionOtherCustomId(sessionId, toolCallId, questionIndex),
    },
  };
}

function buildSingleChoiceComponents(
  sessionId: string,
  toolCallId: string,
  questionIndex: number,
  question: AssistantQuestionInfo
): readonly APIMessageTopLevelComponent[] {
  return [
    {
      type: ComponentType.Container,
      components: [
        createTextDisplay(createQuestionPromptText(question, questionIndex + 1)),
        ...question.options.map((option, optionIndex) =>
          createQuestionOptionSection(sessionId, toolCallId, questionIndex, optionIndex, option)
        ),
        createOtherAnswerSection(sessionId, toolCallId, questionIndex),
      ],
    },
  ];
}

function buildMultipleChoiceComponents(
  sessionId: string,
  toolCallId: string,
  questionIndex: number,
  question: AssistantQuestionInfo
): readonly APIMessageTopLevelComponent[] {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(createQuestionSelectCustomId(sessionId, toolCallId, questionIndex))
    .setPlaceholder('Choose one or more answers')
    .setMinValues(1)
    .setMaxValues(question.options.length)
    .addOptions(
      question.options.map((option) => ({
        label: option.label,
        description: option.description,
        value: option.label,
      }))
    );

  return [
    {
      type: ComponentType.Container,
      components: [
        createTextDisplay(createQuestionPromptText(question, questionIndex + 1)),
        createTextDisplay(
          question.options
            .map((option) => `- **${option.label}** — ${option.description}`)
            .join('\n')
        ),
        {
          type: ComponentType.ActionRow,
          components: [selectMenu.toJSON()],
        },
        createOtherAnswerSection(sessionId, toolCallId, questionIndex),
      ],
    },
  ];
}

function buildQuestionComponents(
  sessionId: string,
  toolCallId: string,
  questionIndex: number,
  question: AssistantQuestionInfo
): readonly APIMessageTopLevelComponent[] {
  return question.multiple
    ? buildMultipleChoiceComponents(sessionId, toolCallId, questionIndex, question)
    : buildSingleChoiceComponents(sessionId, toolCallId, questionIndex, question);
}

export function createQuestionSelectCustomId(
  sessionId: string,
  toolCallId: string,
  questionIndex: number
): string {
  return `${QUESTION_SELECT_CUSTOM_ID_PREFIX}:${encodeCustomIdPart(sessionId)}:${encodeCustomIdPart(toolCallId)}:${questionIndex}`;
}

export function parseQuestionSelectCustomId(customId: string): QuestionSelectCustomId | null {
  const parsedSegments = parseCustomId(customId, QUESTION_SELECT_CUSTOM_ID_PREFIX, 3);

  if (parsedSegments === null) {
    return null;
  }

  const [sessionId, toolCallId, questionIndexStr] = parsedSegments;

  if (sessionId === undefined || toolCallId === undefined || questionIndexStr === undefined) {
    return null;
  }

  const questionIndex = Number.parseInt(questionIndexStr, 10);

  if (Number.isNaN(questionIndex) || questionIndex < 0) {
    return null;
  }

  return { sessionId, toolCallId, questionIndex };
}

export function createQuestionOtherCustomId(
  sessionId: string,
  toolCallId: string,
  questionIndex: number
): string {
  return `${QUESTION_OTHER_CUSTOM_ID_PREFIX}:${encodeCustomIdPart(sessionId)}:${encodeCustomIdPart(toolCallId)}:${questionIndex}`;
}

export function parseQuestionOtherCustomId(customId: string): QuestionOtherCustomId | null {
  const parsedSegments = parseCustomId(customId, QUESTION_OTHER_CUSTOM_ID_PREFIX, 3);

  if (parsedSegments === null) {
    return null;
  }

  const [sessionId, toolCallId, questionIndexStr] = parsedSegments;

  if (sessionId === undefined || toolCallId === undefined || questionIndexStr === undefined) {
    return null;
  }

  const questionIndex = Number.parseInt(questionIndexStr, 10);

  if (Number.isNaN(questionIndex) || questionIndex < 0) {
    return null;
  }

  return { sessionId, toolCallId, questionIndex };
}

export function createQuestionOptionCustomId(
  sessionId: string,
  toolCallId: string,
  questionIndex: number,
  optionIndex: number
): string {
  return `${QUESTION_OPTION_CUSTOM_ID_PREFIX}:${encodeCustomIdPart(sessionId)}:${encodeCustomIdPart(toolCallId)}:${questionIndex}:${optionIndex}`;
}

export function parseQuestionOptionCustomId(customId: string): QuestionOptionCustomId | null {
  const parsedSegments = parseCustomId(customId, QUESTION_OPTION_CUSTOM_ID_PREFIX, 4);

  if (parsedSegments === null) {
    return null;
  }

  const [sessionId, toolCallId, questionIndexStr, optionIndexStr] = parsedSegments;

  if (
    sessionId === undefined ||
    toolCallId === undefined ||
    questionIndexStr === undefined ||
    optionIndexStr === undefined
  ) {
    return null;
  }

  const questionIndex = Number.parseInt(questionIndexStr, 10);
  const optionIndex = Number.parseInt(optionIndexStr, 10);

  if (
    Number.isNaN(questionIndex) ||
    questionIndex < 0 ||
    Number.isNaN(optionIndex) ||
    optionIndex < 0
  ) {
    return null;
  }

  return { sessionId, toolCallId, questionIndex, optionIndex };
}

export function createQuestionModalCustomId(
  sessionId: string,
  toolCallId: string,
  questionIndex: number,
  messageId: string
): string {
  return `${QUESTION_MODAL_CUSTOM_ID_PREFIX}:${encodeCustomIdPart(sessionId)}:${encodeCustomIdPart(toolCallId)}:${questionIndex}:${encodeCustomIdPart(messageId)}`;
}

export function parseQuestionModalCustomId(customId: string): QuestionModalCustomId | null {
  const parsedSegments = parseCustomId(customId, QUESTION_MODAL_CUSTOM_ID_PREFIX, 4);

  if (parsedSegments === null) {
    return null;
  }

  const [sessionId, toolCallId, questionIndexStr, messageId] = parsedSegments;

  if (
    sessionId === undefined ||
    toolCallId === undefined ||
    questionIndexStr === undefined ||
    messageId === undefined
  ) {
    return null;
  }

  const questionIndex = Number.parseInt(questionIndexStr, 10);

  if (Number.isNaN(questionIndex) || questionIndex < 0) {
    return null;
  }

  return {
    sessionId,
    toolCallId,
    questionIndex,
    messageId,
  };
}

export function createQuestionAnswerModal(
  sessionId: string,
  toolCallId: string,
  questionIndex: number,
  messageId: string
): ModalBuilder {
  return new ModalBuilder({
    custom_id: createQuestionModalCustomId(sessionId, toolCallId, questionIndex, messageId),
    title: 'Submit other answer',
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: QUESTION_CUSTOM_ANSWER_FIELD_ID,
            label: 'Other answer',
            placeholder: 'Type your answer',
            required: true,
            style: TextInputStyle.Paragraph,
            max_length: 4000,
          },
        ],
      },
    ],
  });
}

export function createSubmittedQuestionContent(
  originalContent: string,
  answers: readonly string[]
): string {
  const formattedAnswers = answers.map((answer) => `\`${escapeInlineCode(answer)}\``).join(', ');
  return `${originalContent}\n\n✅ Submitted: ${formattedAnswers}`;
}

export function createSubmittedQuestionComponents(
  answers: readonly string[]
): readonly APIMessageTopLevelComponent[] {
  const formattedAnswers = answers.map((answer) => `\`${escapeInlineCode(answer)}\``).join(', ');

  return [
    {
      type: ComponentType.Container,
      components: [createTextDisplay(`✅ Submitted: ${formattedAnswers}`)],
    },
  ];
}

export function createCompletedQuestionContent(title?: string): string {
  return `> :done: Task ${title ?? ''}`.trim();
}
// Returns a single text component with question and answer
export function createCompletedQuestionComponents(
  question: string,
  answers: readonly string[]
): readonly APIMessageTopLevelComponent[] {
  const answerText = answers.map((answer) => `\`${escapeInlineCode(answer)}\``).join(', ');
  const text = new TextDisplayBuilder().setContent(
    `> :white_check_mark: **Question** ${question}: ${answerText}`
  );

  return [text.toJSON()];
}

export async function renderQuestionToolCallPart(
  _context: OpencodeSdkContext,
  part: AssistantToolCallPart
): Promise<RenderedDiscordPart | null> {
  const questionToolCall = parseAssistantQuestionToolCall(part);

  if (questionToolCall === null || questionToolCall.questions.length === 0) {
    return null;
  }

  const { sessionId, callId: toolCallId, questions } = questionToolCall;

  // Validate all questions have valid options
  for (const question of questions) {
    if (question.options.length === 0 || question.options.length > MAX_SELECT_OPTIONS) {
      return null;
    }
  }

  // Build components for all questions
  const allComponents: APIMessageTopLevelComponent[] = [];

  for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
    const question = questions[questionIndex];
    if (question === undefined) {
      continue;
    }
    const components = buildQuestionComponents(sessionId, toolCallId, questionIndex, question);
    allComponents.push(...components);
  }

  const renderedPart: RenderedDiscordPart = {
    id: part.id,
    kind: 'question',
    label: 'Question',
    content: '',
    components: allComponents,
    usesComponentsV2: true,
  };

  return renderedPart;
}
