import type {
  APIMessageTopLevelComponent,
  APISectionComponent,
  APITextDisplayComponent,
} from 'discord-api-types/v10';
import {
  ActionRowBuilder,
  ButtonStyle,
  ComponentType,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import {
  parseAssistantQuestionToolCall,
  type AssistantQuestionInfo,
  type AssistantToolCallPart,
} from '../opencode/parts.js';
import { resolveQuestionId } from '../opencode/questionReplies.js';
import type { OpencodeSdkContext } from '../opencode/sdk.js';
import { createLogger } from '../utils/logger.js';
import type { RenderedDiscordPart } from './partRenderer.js';

const QUESTION_SELECT_CUSTOM_ID_PREFIX = 'mpp-question-select';
const QUESTION_OTHER_CUSTOM_ID_PREFIX = 'mpp-question-other';
const QUESTION_OPTION_CUSTOM_ID_PREFIX = 'mpp-question-option';
const QUESTION_MODAL_CUSTOM_ID_PREFIX = 'mpp-question-modal';
export const QUESTION_CUSTOM_ANSWER_FIELD_ID = 'answer';
const MAX_SELECT_OPTIONS = 25;
const logger = createLogger({ module: 'discord:question-ui' });

export interface QuestionSelectCustomId {
  questionId: string;
  questionIndex: number;
}

export interface QuestionOtherCustomId {
  questionId: string;
  questionIndex: number;
}

export interface QuestionOptionCustomId {
  questionId: string;
  questionIndex: number;
  optionIndex: number;
}

export interface QuestionModalCustomId {
  questionId: string;
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
  questionId: string,
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
      custom_id: createQuestionOptionCustomId(questionId, questionIndex, optionIndex),
    },
  };
}

function createOtherAnswerSection(questionId: string, questionIndex: number): APISectionComponent {
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
      custom_id: createQuestionOtherCustomId(questionId, questionIndex),
    },
  };
}

function buildSingleChoiceComponents(
  questionId: string,
  questionIndex: number,
  question: AssistantQuestionInfo
): readonly APIMessageTopLevelComponent[] {
  return [
    {
      type: ComponentType.Container,
      components: [
        createTextDisplay(createQuestionPromptText(question, questionIndex + 1)),
        ...question.options.map((option, optionIndex) =>
          createQuestionOptionSection(questionId, questionIndex, optionIndex, option)
        ),
        createOtherAnswerSection(questionId, questionIndex),
      ],
    },
  ];
}

function buildMultipleChoiceComponents(
  questionId: string,
  questionIndex: number,
  question: AssistantQuestionInfo
): readonly APIMessageTopLevelComponent[] {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(createQuestionSelectCustomId(questionId, questionIndex))
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
        createOtherAnswerSection(questionId, questionIndex),
      ],
    },
  ];
}

function buildQuestionComponents(
  questionId: string,
  questionIndex: number,
  question: AssistantQuestionInfo
): readonly APIMessageTopLevelComponent[] {
  return question.multiple
    ? buildMultipleChoiceComponents(questionId, questionIndex, question)
    : buildSingleChoiceComponents(questionId, questionIndex, question);
}

export function createQuestionSelectCustomId(questionId: string, questionIndex: number): string {
  return `${QUESTION_SELECT_CUSTOM_ID_PREFIX}:${encodeCustomIdPart(questionId)}:${questionIndex}`;
}

export function parseQuestionSelectCustomId(customId: string): QuestionSelectCustomId | null {
  const parsedSegments = parseCustomId(customId, QUESTION_SELECT_CUSTOM_ID_PREFIX, 2);

  if (parsedSegments === null) {
    return null;
  }

  const [questionId, questionIndexStr] = parsedSegments;

  if (questionId === undefined || questionIndexStr === undefined) {
    return null;
  }

  const questionIndex = Number.parseInt(questionIndexStr, 10);

  if (Number.isNaN(questionIndex) || questionIndex < 0) {
    return null;
  }

  return { questionId, questionIndex };
}

export function createQuestionOtherCustomId(questionId: string, questionIndex: number): string {
  return `${QUESTION_OTHER_CUSTOM_ID_PREFIX}:${encodeCustomIdPart(questionId)}:${questionIndex}`;
}

export function parseQuestionOtherCustomId(customId: string): QuestionOtherCustomId | null {
  const parsedSegments = parseCustomId(customId, QUESTION_OTHER_CUSTOM_ID_PREFIX, 2);

  if (parsedSegments === null) {
    return null;
  }

  const [questionId, questionIndexStr] = parsedSegments;

  if (questionId === undefined || questionIndexStr === undefined) {
    return null;
  }

  const questionIndex = Number.parseInt(questionIndexStr, 10);

  if (Number.isNaN(questionIndex) || questionIndex < 0) {
    return null;
  }

  return { questionId, questionIndex };
}

export function createQuestionOptionCustomId(
  questionId: string,
  questionIndex: number,
  optionIndex: number
): string {
  return `${QUESTION_OPTION_CUSTOM_ID_PREFIX}:${encodeCustomIdPart(questionId)}:${questionIndex}:${optionIndex}`;
}

export function parseQuestionOptionCustomId(customId: string): QuestionOptionCustomId | null {
  const parsedSegments = parseCustomId(customId, QUESTION_OPTION_CUSTOM_ID_PREFIX, 3);

  if (parsedSegments === null) {
    return null;
  }

  const [questionId, questionIndexStr, optionIndexStr] = parsedSegments;

  if (questionId === undefined || questionIndexStr === undefined || optionIndexStr === undefined) {
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

  return { questionId, questionIndex, optionIndex };
}

export function createQuestionModalCustomId(
  questionId: string,
  questionIndex: number,
  messageId: string
): string {
  return `${QUESTION_MODAL_CUSTOM_ID_PREFIX}:${encodeCustomIdPart(questionId)}:${questionIndex}:${encodeCustomIdPart(messageId)}`;
}

export function parseQuestionModalCustomId(customId: string): QuestionModalCustomId | null {
  const parsedSegments = parseCustomId(customId, QUESTION_MODAL_CUSTOM_ID_PREFIX, 3);

  if (parsedSegments === null) {
    return null;
  }

  const [questionId, questionIndexStr, messageId] = parsedSegments;

  if (questionId === undefined || questionIndexStr === undefined || messageId === undefined) {
    return null;
  }

  const questionIndex = Number.parseInt(questionIndexStr, 10);

  if (Number.isNaN(questionIndex) || questionIndex < 0) {
    return null;
  }

  return {
    questionId,
    questionIndex,
    messageId,
  };
}

export function createQuestionAnswerModal(
  questionId: string,
  questionIndex: number,
  messageId: string
): ModalBuilder {
  const answerInput = new TextInputBuilder()
    .setCustomId(QUESTION_CUSTOM_ANSWER_FIELD_ID)
    .setLabel('Other answer')
    .setPlaceholder('Type your answer')
    .setRequired(true)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000);

  return new ModalBuilder()
    .setCustomId(createQuestionModalCustomId(questionId, questionIndex, messageId))
    .setTitle('Submit other answer')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(answerInput));
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

export function createCompletedQuestionComponents(
  answers: readonly string[]
): readonly APIMessageTopLevelComponent[] {
  const completedText = new TextDisplayBuilder().setContent(createCompletedQuestionContent());
  const separator = new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small);
  const answerText = new TextDisplayBuilder().setContent(
    `Answer: ${answers.map((answer) => `\`${escapeInlineCode(answer)}\``).join(', ')}`
  );

  return [
    {
      type: ComponentType.Container,
      components: [completedText.toJSON(), separator.toJSON(), answerText.toJSON()],
    },
  ];
}

export async function renderQuestionToolCallPart(
  context: OpencodeSdkContext,
  part: AssistantToolCallPart
): Promise<RenderedDiscordPart | null> {
  const questionToolCall = parseAssistantQuestionToolCall(part);

  if (questionToolCall === null || questionToolCall.questions.length === 0) {
    return null;
  }

  const interactionToolMessageId = questionToolCall.toolMessageId;

  logger.debug(
    {
      partId: part.id,
      sessionId: questionToolCall.sessionId,
      toolMessageId: interactionToolMessageId,
    },
    'Resolving question id during Discord question render'
  );

  const questionId = await resolveQuestionId(
    context,
    questionToolCall.sessionId,
    interactionToolMessageId
  );

  logger.debug(
    {
      partId: part.id,
      sessionId: questionToolCall.sessionId,
      toolMessageId: interactionToolMessageId,
      questionId,
    },
    'Resolved question id during Discord question render'
  );

  // Validate all questions have valid options
  for (const question of questionToolCall.questions) {
    if (question.options.length === 0 || question.options.length > MAX_SELECT_OPTIONS) {
      return null;
    }
  }

  // Build components for all questions
  const allComponents: APIMessageTopLevelComponent[] = [];

  for (let questionIndex = 0; questionIndex < questionToolCall.questions.length; questionIndex++) {
    const question = questionToolCall.questions[questionIndex];
    if (question === undefined) {
      continue;
    }
    const components = buildQuestionComponents(questionId, questionIndex, question);
    allComponents.push(...components);
  }

  questionToolCall.questionId = questionId;

  const renderedPart: RenderedDiscordPart & { questionId: string } = {
    id: part.id,
    kind: 'question',
    label: 'Question',
    content: '',
    components: allComponents,
    usesComponentsV2: true,
    questionId,
  };

  return renderedPart;
}
