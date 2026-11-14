import type { APIEmbed } from "discord.js";
import { ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown, MediaGalleryBuilder, SectionBuilder, SeparatorBuilder, TextDisplayBuilder, ThumbnailBuilder } from "discord.js";

export class EmbedInputError extends Error {}

// Regular Discord embeds require both field properties to contain text.
const blankFieldText = "\u200b";

export function updateV2Text<T>(components: T[], input: unknown): T[] {
  if (!Array.isArray(input)) throw new EmbedInputError("Enter the message text.");
  const blocks: unknown[] = input;
  let index = 0;
  function update(node: unknown): void {
    const component = object(node);
    if (component.type === 10) {
      const value = blocks[index++];
      if (typeof value !== "string" || !value.trim() || value.length > 4096)
        throw new EmbedInputError("Each text block needs 1 to 4,096 characters.");
      component.content = value;
    }
    if (Array.isArray(component.components)) component.components.forEach(update);
  }
  components.forEach(update);
  if (!index || index !== input.length) throw new EmbedInputError("Reload the message before editing its text.");
  return components;
}

export function composeV2Container(embed: APIEmbed, divider: boolean, buttonInput?: unknown) {
  const button = buttonInput === undefined ? undefined : object(buttonInput);
  const label = text(button?.label, "Button label", 80);
  const url = link(button?.url, "Button link");
  if (button && (!label || !url || !embed.description))
    throw new EmbedInputError("Enter a description, button label, and button link.");
  const container = new ContainerBuilder();
  if (embed.color !== undefined) container.setAccentColor(embed.color);
  function heading(label: string, url?: string) {
    const value = escapeMarkdown(label.replace(/\s+/g, " ")).replace(/[\[\]]/g, "\\$&");
    const target = url?.replaceAll("(", "%28").replaceAll(")", "%29");
    return target ? `**[${value}](${target})**` : `**${value}**`;
  }
  const thumbnail = button ? undefined : embed.thumbnail?.url;
  let thumbnailPlaced = false;
  function addText(content: string, description = false) {
    const display = new TextDisplayBuilder().setContent(content);
    if (description && label && url) {
      container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(display)
        .setButtonAccessory(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url)));
    } else if (thumbnail && !thumbnailPlaced && (description || !embed.description)) {
      container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(display)
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail)));
      thumbnailPlaced = true;
    } else {
      container.addTextDisplayComponents(display);
    }
  }
  if (embed.author) addText(heading(embed.author.name, embed.author.url));
  if (embed.title) {
    addText(heading(embed.title, embed.url));
    if (divider) container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  }
  if (embed.description) addText(embed.description, true);
  for (const field of embed.fields ?? []) {
    const name = field.name === blankFieldText ? "" : heading(field.name);
    const value = field.value === blankFieldText ? "" : field.value;
    const content = [name, value].filter(Boolean).join("\n");
    if (content) addText(content);
  }
  const timestamp = embed.timestamp ? `<t:${Math.floor(Date.parse(embed.timestamp) / 1000)}:f>` : "";
  const footer = [embed.footer && escapeMarkdown(embed.footer.text), timestamp].filter(Boolean).join(" • ");
  const images = [embed.image?.url, !thumbnailPlaced && !footer && thumbnail].filter((url): url is string => !!url);
  if (images.length) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(images.map(url => ({ media: { url } }))));
  if (footer) {
    const previous = container.components.at(-1);
    if (divider && previous && !(previous instanceof SeparatorBuilder)) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    }
    addText(footer);
  }
  return container;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EmbedInputError("Invalid embed.");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number) {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new EmbedInputError(`Enter ${label} as text.`);
  const result = value.trim();
  if (result.length > max) throw new EmbedInputError(`${label} must be ${max} characters or fewer.`);
  return result;
}

function link(value: unknown, label: string) {
  const input = text(value, label, 2048);
  if (!input) return "";
  try {
    const url = new URL(input);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
  throw new EmbedInputError(`${label} must be an HTTP or HTTPS URL.`);
}

export function composeEmbed(input: unknown): APIEmbed {
  const data = object(input);
  const title = text(data.title, "Title", 256);
  const description = text(data.description, "Description", 4096);
  const url = link(data.url, "Title link");
  const author = text(data.authorName, "Author name", 256);
  const authorUrl = link(data.authorUrl, "Author link");
  const authorIcon = link(data.authorIcon, "Author icon");
  const footer = text(data.footerText, "Footer text", 2048);
  const footerIcon = link(data.footerIcon, "Footer icon");
  const image = link(data.image, "Image");
  const thumbnail = link(data.thumbnail, "Thumbnail");
  const color = text(data.color, "Accent color", 7);
  const timestamp = text(data.timestamp, "Timestamp", 24);
  if (url && !title) throw new EmbedInputError("Enter a title to use a title link.");
  if ((authorUrl || authorIcon) && !author) throw new EmbedInputError("Enter an author name to use an author link or icon.");
  if (footerIcon && !footer) throw new EmbedInputError("Enter footer text to use a footer icon.");
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new EmbedInputError("Enter a color like #5865f2.");
  if (timestamp && !Number.isFinite(Date.parse(timestamp))) throw new EmbedInputError("Enter a valid timestamp.");

  const rows = data.fields === undefined ? [] : data.fields;
  if (!Array.isArray(rows) || rows.length > 25) throw new EmbedInputError("Use up to 25 fields.");
  const fields = rows.flatMap(row => {
    const field = object(row);
    const name = text(field.name, "Field name", 256);
    const value = text(field.value, "Field text", 1024);
    if ((!name || name === blankFieldText) && (!value || value === blankFieldText)) return [];
    return [{ name: name || blankFieldText, value: value || blankFieldText, inline: field.inline === true }];
  });
  if (!title && !description && !author && !footer && !image && !thumbnail && !fields.length)
    throw new EmbedInputError("Add text, an image, or a field to the embed.");
  const size = title.length + description.length + author.length + footer.length +
    fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  if (size > 6000) throw new EmbedInputError("Keep the total embed text within 6,000 characters.");

  const embed: APIEmbed = {};
  if (title) embed.title = title;
  if (description) embed.description = description;
  if (url) embed.url = url;
  if (author) embed.author = { name: author, ...(authorUrl && { url: authorUrl }), ...(authorIcon && { icon_url: authorIcon }) };
  if (footer) embed.footer = { text: footer, ...(footerIcon && { icon_url: footerIcon }) };
  if (image) embed.image = { url: image };
  if (thumbnail) embed.thumbnail = { url: thumbnail };
  if (color) embed.color = parseInt(color.slice(1), 16);
  if (timestamp) embed.timestamp = new Date(timestamp).toISOString();
  if (fields.length) embed.fields = fields;
  return embed;
}
