import {
  ActionRowBuilder,
  EmbedBuilder,
  MentionableSelectMenuBuilder,
  type User,
} from 'discord.js';

const ASK_PROMPT_PREVIEW_LIMIT = 500;

function truncatePrompt(prompt: string): string {
  return prompt.length > ASK_PROMPT_PREVIEW_LIMIT
    ? `${prompt.slice(0, ASK_PROMPT_PREVIEW_LIMIT - 1)}…`
    : prompt;
}

export function createAskSetupComponents(
  sessionId: string
): ActionRowBuilder<MentionableSelectMenuBuilder> {
  const selectMenu = new MentionableSelectMenuBuilder()
    .setCustomId(`ask-mentionable:${sessionId}`)
    .setPlaceholder('Tag users or roles to notify');

  return new ActionRowBuilder<MentionableSelectMenuBuilder>().addComponents(selectMenu);
}

export function createAskSetupEmbed(prompt: string, invoker: User): EmbedBuilder {
  const promptPreview = truncatePrompt(prompt);

  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🤖 AI Conversation Started')
    .setDescription(
      [
        `Prompt: ${promptPreview}`,
        `Started by <@${invoker.id}>.`,
        'Use `/agent` to switch agents and `/model` to change models for this conversation.',
      ].join('\n\n')
    )
    .addFields({
      name: 'Prompt preview',
      value: promptPreview,
    });
}

export function createAskErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(0xed4245).setTitle('❌ Error').setDescription(message);
}
