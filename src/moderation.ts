import { sendLog } from "./log-webhooks.js";
import { ApplicationCommandType, ApplicationIntegrationType, AuditLogEvent, ChannelType, ContextMenuCommandBuilder, escapeMarkdown, InteractionContextType, SnowflakeUtil, type GuildAuditLogsEntry } from "discord.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ButtonInteraction, StringSelectMenuBuilder, StringSelectMenuInteraction, ChatInputCommandInteraction, ModalSubmitInteraction, ModalBuilder, LabelBuilder, UserSelectMenuBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ContainerBuilder, SeparatorBuilder, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder, TextDisplayBuilder } from "discord.js";
import { db } from "./db.js";
import type { Guild, GuildMember, GuildTextBasedChannel, MessageContextMenuCommandInteraction, User, UserContextMenuCommandInteraction } from "discord.js";

db.exec(`CREATE TABLE IF NOT EXISTS moderation_settings (guild_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, log_channel_id TEXT);
CREATE TABLE IF NOT EXISTS moderation_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT, moderator_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, cleared INTEGER NOT NULL DEFAULT 0);`);
const caseColumns = db.prepare("PRAGMA table_info(moderation_cases)").all() as Array<{ name: string }>;
if (!caseColumns.some(column => column.name === "message_links")) {
  db.exec("ALTER TABLE moderation_cases ADD COLUMN message_links TEXT NOT NULL DEFAULT '[]'");
}
if (!caseColumns.some(column => column.name === "message_text")) {
  db.exec("ALTER TABLE moderation_cases ADD COLUMN message_text TEXT");
}
if (!caseColumns.some(column => column.name === "discord_audit_entry_id")) {
  db.exec("ALTER TABLE moderation_cases ADD COLUMN discord_audit_entry_id TEXT");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS moderation_cases_discord_audit_entry ON moderation_cases(discord_audit_entry_id) WHERE discord_audit_entry_id IS NOT NULL");
export type WarningRule = { warnings: number; action: "timeout" | "kick" | "ban"; minutes?: number };
if (!(db.prepare("PRAGMA table_info(moderation_settings)").all() as Array<{ name: string }>).some(column => column.name === "warning_rules")) {
  db.exec("ALTER TABLE moderation_settings ADD COLUMN warning_rules TEXT NOT NULL DEFAULT '[]'");
}
for (const column of ["admin_role_id", "moderator_role_id", "honeypot_channel_id", "honeypot_exempt_role_ids"]) {
  if (!(db.prepare("PRAGMA table_info(moderation_settings)").all() as Array<{ name: string }>).some(entry => entry.name === column)) db.exec(`ALTER TABLE moderation_settings ADD COLUMN ${column} TEXT`);
}
export function validateWarningRules(value: unknown): WarningRule[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Use up to 20 warning rules.");
  const seen = new Set<number>();
  return value.map(rule => {
    if (!rule || !Number.isInteger(rule.warnings) || rule.warnings < 1 || rule.warnings > 100 || seen.has(rule.warnings)) throw new Error("Each rule needs a unique warning count between 1 and 100.");
    if (!["timeout", "kick", "ban"].includes(rule.action)) throw new Error("Choose timeout, kick, or ban.");
    if (rule.action === "timeout" && (!Number.isInteger(rule.minutes) || rule.minutes < 1 || rule.minutes > 40320)) throw new Error("Timeout rules need 1-40,320 whole minutes.");
    seen.add(rule.warnings);
    return { warnings: rule.warnings, action: rule.action, ...(rule.action === "timeout" ? { minutes: rule.minutes } : {}) } as WarningRule;
  }).sort((a, b) => a.warnings - b.warnings);
}
export function warningRules(settings: { warning_rules: string }): WarningRule[] {
  try { return validateWarningRules(JSON.parse(settings.warning_rules || "[]")); } catch { return []; }
}
function activeWarningCount(guildId: string, userId: string) {
  return (db.prepare("SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id=? AND user_id=? AND action='warn' AND cleared=0").get(guildId, userId) as { count: number }).count;
}
export function moderationSettings(guildId: string) {
  db.prepare("INSERT OR IGNORE INTO moderation_settings (guild_id, enabled) VALUES (?, 0)").run(guildId);
  return db.prepare("SELECT * FROM moderation_settings WHERE guild_id=?").get(guildId) as { enabled: number; honeypot_exempt_role_ids: string | null; honeypot_channel_id: string | null; log_channel_id: string | null; warning_rules: string; admin_role_id: string | null; moderator_role_id: string | null };
}
const honeypotInFlight = new Set<string>();
const banChangesInFlight = new Set<string>();
const softbanDeleteSeconds = 86400;

function startBanChange(key: string) {
  if (banChangesInFlight.has(key)) return;
  banChangesInFlight.add(key);
  return () => { banChangesInFlight.delete(key); };
}

export async function handleHoneypotMessage(message: import("discord.js").Message): Promise<boolean> {
  const guild = message.guild;
  if (!guild || message.author.bot || message.webhookId) return false;
  const settings = moderationSettings(guild.id);
  if (!settings.enabled || settings.honeypot_channel_id !== message.channelId) return false;
  const key = `${guild.id}:${message.author.id}`;
  if (honeypotInFlight.has(key)) return true;
  honeypotInFlight.add(key);
  let outcome = "Honeypot failed", failure = "";
  let endBanChange: (() => void) | undefined;
  try {
    const member = await guild.members.fetch(message.author.id);
    if (member.id === guild.ownerId || member.permissions.has(P.Administrator) || member.permissions.has(P.BanMembers)
      || [settings.admin_role_id, settings.moderator_role_id, settings.honeypot_exempt_role_ids].flatMap(ids => (ids || "").split(",")).some(id => id && member.roles.cache.has(id))) {
      try { await message.delete(); }
      catch { throw new Error("Could not delete honeypot message. Check bot Manage Messages permission."); }
      return true;
    }
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(P.BanMembers) || !member.bannable) throw new Error("Check bot Ban Members permission and role order.");
    endBanChange = startBanChange(key);
    if (!endBanChange) throw new Error("A ban action is already in progress for this member.");
    try {
      await message.author.send({
        components: [new ContainerBuilder().setAccentColor(0xf45f77).addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`You were banned from ${guild.name} for posting in a honeypot channel.`)
        )],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }
      });
    } catch { failure = "Could not DM member."; }
    await guild.members.ban(message.author.id, { deleteMessageSeconds: softbanDeleteSeconds, reason: "Honeypot channel message" });
    outcome = "Ban";
    try {
      await guild.bans.remove(message.author.id, "Honeypot softban: allow rejoining");
      outcome = "Softban";
    } catch { failure = [failure, "Unban failed; member remains banned. Unban them manually."].filter(Boolean).join("\n"); }
    db.prepare("INSERT INTO moderation_cases (guild_id,user_id,moderator_id,action,reason,created_at,message_links) VALUES (?,?,?,?,?,?,?)")
      .run(guild.id, message.author.id, me.id, outcome.toLowerCase(), "Honeypot channel message", new Date().toISOString(), JSON.stringify([message.url]));
  } catch (error) {
    failure = [failure, error instanceof Error ? error.message : "Could not softban member."].filter(Boolean).join("\n");
  } finally {
    endBanChange?.();
    honeypotInFlight.delete(key);
  }
  if (failure) console.error(`Honeypot ${guild.id}/${message.author.id}: ${failure}`);
  if (settings.log_channel_id) {
    try {
      const channel = await guild.channels.fetch(settings.log_channel_id);
      if (!channel?.isSendable()) throw new Error("Moderation log channel unavailable");
      await sendLog(guild, channel, "moderation", { embeds: [new EmbedBuilder().setColor(0x77f45f).setDescription(
        `${outcome}: ${message.author.username}\nMod: ${message.client.user?.username || "Bot"}\nReason: Honeypot channel message\n${message.url}${failure ? `\n${failure}` : ""}`
      )], allowedMentions: { parse: [] } });
    } catch (error) { console.error("Honeypot log failed", error); }
  }
  return true;
}
export function moderationCases(guildId: string) {
  return db.prepare("SELECT id,guild_id,user_id,moderator_id,action,reason,created_at,cleared,message_links,discord_audit_entry_id FROM moderation_cases WHERE guild_id=? ORDER BY id DESC LIMIT 50").all(guildId);
}
const permissions: Record<string, bigint> = { warn: P.ModerateMembers, warnings: P.ModerateMembers, clearwarnings: P.ModerateMembers, timeout: P.ModerateMembers, untimeout: P.ModerateMembers, kick: P.KickMembers, softban: P.BanMembers, ban: P.BanMembers, unban: P.BanMembers, purge: P.ManageMessages };
async function escalateWarning(
  guild: Guild, actor: GuildMember, userId: string, count: number, rule: WarningRule,
  caseId: string, auditReason: string, recordedReason: string, messageLinks: string[],
  { automatic = false, messageText = null }: { automatic?: boolean; messageText?: string | null } = {}
) {
  const target = await guild.members.fetch(userId).catch(() => null);
  const currentActor = await guild.members.fetch(automatic ? { user: actor.id, force: true } : actor.id);
  const currentBot = await guild.members.fetchMe();
  if (userId === guild.ownerId || userId === currentActor.id || userId === currentBot.id) throw new Error("This member is protected");
  if (automatic && !currentActor.permissions.has([P.ManageGuild, P.ModerateMembers, permissions[rule.action]])) {
    throw new Error("Rule author lacks permission for this punishment");
  }
  if (target && currentActor.id !== guild.ownerId && currentActor.roles.highest.comparePositionTo(target.roles.highest) <= 0) throw new Error("Moderator role must be above the member");
  if (!currentBot.permissions.has(permissions[rule.action])) throw new Error(`Bot lacks permission to ${rule.action}`);
  if (target && currentBot.roles.highest.comparePositionTo(target.roles.highest) <= 0) throw new Error("Bot role must be above the member");
  const escalationReason = `Automatic ${rule.action} at warning ${count}: ${auditReason}`.slice(0, 512);
  if (rule.action === "ban") {
    if (automatic && !target) throw new Error("Member is absent");
    if (target && !target.bannable) throw new Error("Member cannot be banned");
    const endBanChange = startBanChange(`${guild.id}:${userId}`);
    if (!endBanChange) throw new Error("A ban action is already in progress for this member.");
    try { await guild.members.ban(userId, { reason: escalationReason }); }
    finally { endBanChange(); }
  } else if (rule.action === "kick") {
    if (!target?.kickable) throw new Error("Member is absent or cannot be kicked");
    await target.kick(escalationReason);
  } else {
    if (!target?.moderatable) throw new Error("Member is absent or cannot be timed out");
    await target.timeout(rule.minutes! * 60000, escalationReason);
  }
  return db.prepare("INSERT INTO moderation_cases (guild_id,user_id,moderator_id,action,reason,created_at,message_links,message_text) VALUES (?,?,?,?,?,?,?,?)")
    .run(guild.id, userId, automatic ? guild.client.user.id : actor.id, rule.action, `Automatic at warning ${count} (warning case #${caseId}): ${recordedReason}${rule.action === "timeout" ? ` - ${rule.minutes} minutes` : ""}`, new Date().toISOString(), JSON.stringify(messageLinks), messageText);
}

export async function recordAutoModCase(
  guild: Guild, userId: string, reason: string, settings: ReturnType<typeof moderationSettings>, actor: GuildMember | null
) {
  const record = db.prepare("INSERT INTO moderation_cases (guild_id,user_id,moderator_id,action,reason,created_at) VALUES (?,?,?,?,?,?)")
    .run(guild.id, userId, guild.client.user.id, actor ? "warn" : "automod", reason, new Date().toISOString());
  const caseId = String(record.lastInsertRowid);
  if (!actor) return { caseId, detail: "" };
  const count = activeWarningCount(guild.id, userId);
  const rule = warningRules(settings).find(entry => entry.warnings === count);
  const details: string[] = [];
  if (rule) {
    try {
      const punishment = await escalateWarning(guild, actor, userId, count, rule, caseId, reason, reason, [], { automatic: true });
      const duration = rule.action === "timeout" ? ` for ${rule.minutes} minutes` : "";
      details.push(`Automatic ${rule.action}${duration} (case #${punishment.lastInsertRowid})`);
    } catch (error) {
      console.error("AutoMod warning escalation failed", error);
      details.push(`Automatic ${rule.action} failed. Check permissions and role order.`);
    }
  }
  try {
    const recipient = await guild.client.users.fetch(userId);
    const embed = new EmbedBuilder().setColor(0xf45f77).setDescription(`You were warned in ${guild.name} for ${reason}`);
    await recipient.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error("AutoMod warning DM failed", error);
    details.push("Warning DM could not be delivered.");
  }
  return { caseId, detail: details.join("\n") };
}

export function recordAutoModTimeout(guild: Guild, userId: string, reason: string, minutes: number) {
  const record = db.prepare("INSERT INTO moderation_cases (guild_id,user_id,moderator_id,action,reason,created_at) VALUES (?,?,?,?,?,?)")
    .run(guild.id, userId, guild.client.user.id, "timeout", `${reason} - ${minutes} minutes`, new Date().toISOString());
  return { caseId: String(record.lastInsertRowid), detail: `Length: ${minutes} minutes` };
}

export async function handleDiscordTimeout(entry: GuildAuditLogsEntry, guild: Guild) {
  const { action, targetId, executorId, createdTimestamp } = entry;
  if (action !== AuditLogEvent.MemberUpdate || !targetId || !executorId || executorId === guild.client.user.id) return;
  const change = entry.changes.find(field => field.key === "communication_disabled_until");
  if (!change || change.new === change.old) return;
  const expiresAt = typeof change.new === "string" ? Date.parse(change.new) : NaN;
  const previousExpiry = typeof change.old === "string" ? Date.parse(change.old) : NaN;
  const applied = expiresAt > createdTimestamp;
  const removed = change.new == null && previousExpiry > createdTimestamp;
  if (!applied && !removed) return;
  const settings = moderationSettings(guild.id);
  if (!settings.enabled) return;
  const minutes = applied ? Math.max(1, Math.round((expiresAt - createdTimestamp) / 60000)) : null;
  const reason = entry.reason?.trim() || "No reason provided";
  const recordedReason = minutes === null ? reason : `${reason} - ${minutes} minutes`;
  const record = db.prepare(`
    INSERT INTO moderation_cases (guild_id,user_id,moderator_id,action,reason,created_at,discord_audit_entry_id)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING
  `).run(guild.id, targetId, executorId, applied ? "timeout" : "untimeout", recordedReason, entry.createdAt.toISOString(), entry.id);
  if (!record.changes || !settings.log_channel_id) return;

  const [channel, member, moderator] = await Promise.all([
    guild.channels.fetch(settings.log_channel_id),
    guild.client.users.fetch(targetId).catch(() => null),
    entry.executor ?? guild.client.users.fetch(executorId).catch(() => null)
  ]);
  if (!channel?.isSendable()) throw new Error("Moderation log channel unavailable");
  const details = [
    `Case #${record.lastInsertRowid} - ${applied ? "Timeout" : "Timeout removed"}: ${member?.username ?? targetId}`,
    `Mod: ${moderator?.username ?? executorId}`,
    minutes === null ? "" : `Length: ${minutes} minutes`,
    entry.reason?.trim() ? `Reason: ${reason}` : ""
  ].filter(Boolean).join("\n");
  await sendLog(guild, channel, "moderation", {
    embeds: [new EmbedBuilder().setColor(0xf45f77).setDescription(details)],
    allowedMentions: { parse: [] }
  });
}
const slashActionNames = { warn: "Warn member", warnings: "Modlogs", clearwarnings: "Clear case", timeout: "Timeout member", untimeout: "Remove timeout", kick: "Kick member", ban: "Ban member", unban: "Unban user", purge: "Purge messages" };
const actionNames: Record<string, string> = { ...slashActionNames, softban: "Softban member" };
const memberPunishments = [
  { label: "Warn", value: "warn" },
  { label: "Timeout", value: "timeout" },
  { label: "Kick", value: "kick" },
  { label: "Softban", value: "softban" },
  { label: "Ban", value: "ban" }
];
const messageModActions = [...memberPunishments, { label: "Purge", value: "purge" }];
const memberModActions = [{ label: "Modlogs", value: "warnings" }, ...memberPunishments, { label: "Clear Warning", value: "clearwarnings" }];
const moderationContextMenus = [
  [ApplicationCommandType.Message, messageModActions],
  [ApplicationCommandType.User, memberModActions]
] as const;
type ModerationContextInteraction = MessageContextMenuCommandInteraction | UserContextMenuCommandInteraction;
export const moderationCommands = [new SlashCommandBuilder()
  .setName("mod").setDescription("Use server moderation tools").setDMPermission(false)
  .addStringOption(option => option.setName("action").setDescription("Choose a moderation action").setRequired(true)
    .addChoices(...Object.entries(slashActionNames).map(([value, name]) => ({ name, value })))),
  ...moderationContextMenus.flatMap(([type, actions]) => actions.map(({ label, value }) => new ContextMenuCommandBuilder().setName(label).setType(type)
    .setDefaultMemberPermissions(permissions[value])
    .setContexts(InteractionContextType.Guild).setIntegrationTypes(ApplicationIntegrationType.GuildInstall)))
];

function canModerate(interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction | StringSelectMenuInteraction | ModerationContextInteraction, action: string, allowDiscordPermission = true) {
  if (allowDiscordPermission && interaction.memberPermissions?.has(permissions[action])) return true;
  const settings = moderationSettings(interaction.guildId!);
  const member = interaction.member;
  const roles = member?.roles;
  const hasRole = (ids: string | null) => !!roles && (ids || "").split(",").some(id => !!id && (Array.isArray(roles) ? roles.includes(id) : roles.cache.has(id)));
  return hasRole(settings.admin_role_id) || (!["ban", "softban", "unban"].includes(action) && hasRole(settings.moderator_role_id));
}

function shortInput(id: string, label: string, required = true, maxLength = 400) {
  return new LabelBuilder().setLabel(label)
    .setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(maxLength));
}

export function moderationModal(action: string, ownerId: string, target?: string | User, sourceMessageId?: string) {
  const fixedTarget = typeof target === "object" ? target : undefined;
  const customId = ["moderation", action, ownerId, fixedTarget?.id, sourceMessageId].filter(Boolean).join(":");
  const modal = new ModalBuilder().setCustomId(customId)
    .setTitle(fixedTarget && action === "clearwarnings" ? "Clear Warning" : actionNames[action]);
  if (action === "purge") modal.addLabelComponents(shortInput("amount", "Number of recent messages (1-100)", true, 3));
  else if (action === "unban") modal.addLabelComponents(shortInput("user-id", "Discord ID of the banned user", true, 20));
  else if (fixedTarget) modal.addTextDisplayComponents(new TextDisplayBuilder().setContent(`Member: ${escapeMarkdown(fixedTarget.username)}`));
  else {
    const memberSelect = new UserSelectMenuBuilder().setCustomId("member").setMinValues(1).setMaxValues(1);
    if (typeof target === "string") memberSelect.setDefaultUsers(target);
    modal.addLabelComponents(new LabelBuilder().setLabel("Member").setUserSelectMenuComponent(memberSelect));
  }
  if (action === "clearwarnings") modal.addLabelComponents(shortInput("case-number", "Warning case number to clear", true, 16));
  if (action === "timeout") modal.addLabelComponents(shortInput("minutes", "Timeout duration in minutes (1-40,320)", true, 5));
  if (action === "softban") modal.addTextDisplayComponents(new TextDisplayBuilder().setContent("Removes the member and up to 24 hours of their messages, then allows them to rejoin."));
  if (action !== "warnings") modal.addLabelComponents(shortInput("reason", "Reason", action === "warn"));
  if (!sourceMessageId && memberPunishments.some(({ value }) => value === action)) modal.addLabelComponents(new LabelBuilder().setLabel("Message link (optional)")
    .setDescription("Paste one link using Discord's Copy Message Link.")
    .setTextInputComponent(new TextInputBuilder().setCustomId("message-links").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(1000)));
  return modal;
}
function moderationReply(title: string, body: string) {
  return new ContainerBuilder().setAccentColor(0xf45f77)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`<:exmark:1553453281022582824> **${title}**`))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
}

function discordMessageLinkParts(link: string) {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" || !["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"].includes(url.hostname) || url.port || url.username || url.password || /\s/.test(link)) return null;
    return url.pathname.match(/^\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/);
  } catch { return null; }
}

function modlogMessageSources(storedLinks: string, guildId: string) {
  let links: unknown;
  try { links = JSON.parse(storedLinks); } catch { return []; }
  if (!Array.isArray(links)) return [];
  return links.flatMap(link => {
    const path = typeof link === "string" ? discordMessageLinkParts(link) : null;
    return path?.[1] === guildId ? [{ channelId: path[2], messageId: path[3] }] : [];
  });
}

async function readableMessageText(viewer: GuildMember | null, channelId: string, messageId: string, savedText: string | null = null) {
  if (!viewer) return null;
  const channel = await viewer.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  const permissions = channel.permissionsFor(viewer);
  if (!permissions?.has([P.ViewChannel, P.ReadMessageHistory])) return null;
  if (channel.type === ChannelType.PrivateThread && !permissions.has(P.ManageThreads)) {
    const membership = await channel.members.fetch({ member: viewer.id, force: true, cache: false }).catch(() => null);
    if (!membership) return null;
  }
  if (savedText !== null) return savedText;
  const message = await channel.messages.fetch({ message: messageId, force: true, cache: false }).catch(() => null);
  return message?.content ?? null;
}

function modlogMessageText(text: string | null, maxLength: number) {
  if (!text?.trim()) {
    const label = text === null ? "Message unavailable." : "Message has no text.";
    return label.length <= maxLength ? label : "";
  }
  const header = "**Message**\n```\n";
  const footer = "\n```";
  const textLimit = maxLength - header.length - footer.length;
  if (textLimit < 4) return "";
  const safeText = text.replace(/``/g, "`\u200b`");
  const excerpt = safeText.length <= textLimit ? safeText : `${safeText.slice(0, textLimit - 3).replace(/[\uD800-\uDBFF]$/, "")}...`;
  return `${header}${excerpt}${footer}`;
}

async function memberModlogs(interaction: ButtonInteraction | ModalSubmitInteraction | UserContextMenuCommandInteraction, targetId: string, ownerId: string, requestedPage = 0, warningsOnly = false, clearedOnly = false) {
  const guildId = interaction.guildId!;
  const pageSize = 4;
  const filter = clearedOnly ? " AND action='warn' AND cleared=1" : warningsOnly ? " AND action='warn' AND cleared=0" : " AND NOT (action='warn' AND cleared=1)";
  const pageTool = clearedOnly ? "cleared-page" : warningsOnly ? "warnings-page" : "logs-page";
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id=? AND user_id=?${filter}`).get(guildId, targetId) as { count: number }).count;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(0, Math.min(pages - 1, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
  const rows = db.prepare(`SELECT id,action,moderator_id,reason,created_at,cleared,message_links,message_text FROM moderation_cases WHERE guild_id=? AND user_id=?${filter} ORDER BY id DESC LIMIT ? OFFSET ?`).all(guildId, targetId, pageSize, page * pageSize) as Array<{ id: number; action: string; moderator_id: string; reason: string; created_at: string; cleared: number; message_links: string; message_text: string | null }>;
  const sources = rows.map(row => modlogMessageSources(row.message_links, guildId));
  const viewer = sources.some(links => links.length) && interaction.guild
    ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null;
  const ids = [...new Set([targetId, ...rows.map(row => row.moderator_id)])];
  const messages = sources.map((links, rowIndex) => Promise.all(links.map(({ channelId, messageId }, linkIndex) => {
    const savedText = linkIndex === 0 ? rows[rowIndex].message_text : null;
    return readableMessageText(viewer, channelId, messageId, savedText);
  })));
  const [userEntries, messageTexts] = await Promise.all([
    Promise.all(ids.map(async id => [id, await interaction.client.users.fetch(id).catch(() => null)] as const)),
    Promise.all(messages)
  ]);
  const users = new Map(userEntries);
  const historyType = clearedOnly ? "Cleared warnings" : warningsOnly ? "Warnings" : "Modlogs";
  const title = `**${historyType} for ${users.get(targetId)?.username || targetId}**`;
  const pageLabel = `Page ${page + 1}/${pages} (${total} ${clearedOnly ? "cleared warnings" : warningsOnly ? "active warnings" : "logs"})`;
  const container = new ContainerBuilder().setAccentColor(0xf45f77)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  const labels: Record<string, string> = { warn: "Warn", kick: "Kick", softban: "Softban", ban: "Ban", unban: "Unban", timeout: "Timeout", untimeout: "Timeout removed", clearwarnings: "Warnings cleared", purge: "Purge" };
  const entries = rows.map(row => {
    const duration = row.action === "timeout" ? row.reason.match(/\s*[\u00b7?-]\s*(\d+) minutes$/) : null;
    const reason = duration ? row.reason.slice(0, duration.index) : row.reason;
    const seconds = Math.floor(new Date(row.created_at).getTime() / 1000);
    return `**Case ${row.id} - ${labels[row.action] || row.action}${row.cleared ? " (cleared)" : ""}**\n**Mod:** ${users.get(row.moderator_id)?.username || row.moderator_id}${duration ? `\n**Length:** ${duration[1]} minutes` : ""}\n**Reason:** ${reason}\n<t:${seconds}:F>`;
  });
  const sourceCount = messageTexts.flat().length;
  const messageTextLimit = Math.floor((4000 - title.length - pageLabel.length - entries.join("").length) / (sourceCount || 1)) - 1;
  for (const [index, entry] of entries.entries()) {
    if (index > 0) container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    const previews = messageTexts[index].map(text => modlogMessageText(text, messageTextLimit)).filter(Boolean);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent([entry, ...previews].join("\n")));
  }
  if (!rows.length) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(clearedOnly ? "This member has no cleared warnings." : warningsOnly ? "This member has no active warnings." : "No moderation history for this member."));
  if (total > 0) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(pageLabel));
  }
  const navigation = new ActionRowBuilder<ButtonBuilder>();
  if (pages > 1) navigation.addComponents(
    new ButtonBuilder().setCustomId(`mod-tools:${pageTool}:${ownerId}:${targetId}:${page - 1}`).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`mod-tools:${pageTool}:${ownerId}:${targetId}:${page + 1}`).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1)
  );
  navigation.addComponents(new ButtonBuilder().setCustomId(`mod-tools:${clearedOnly ? "logs-page" : "cleared-page"}:${ownerId}:${targetId}:0`).setLabel(clearedOnly ? "View modlogs" : "Cleared warnings").setStyle(ButtonStyle.Secondary));
  container.addActionRowComponents(navigation);
  return container;
}

async function fetchModerationTarget(interaction: ModalSubmitInteraction, userId: string, force = false) {
  try { return await interaction.guild!.members.fetch(force ? { user: userId, force } : userId); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 10007) return null;
    throw error;
  }
}

const pendingMessageText = new Map<string, { text: string; expiry: ReturnType<typeof setTimeout> }>();

function takePendingMessageText(customId: string) {
  const pending = pendingMessageText.get(customId);
  if (!pending) return undefined;
  clearTimeout(pending.expiry);
  pendingMessageText.delete(customId);
  return pending.text;
}

export async function handleModerationContextCommand(interaction: ModerationContextInteraction) {
  const messageCommand = interaction.isMessageContextMenuCommand();
  const actions = messageCommand ? messageModActions : memberModActions;
  const action = actions.find(({ label }) => label === interaction.commandName)?.value;
  if (!action) return false;
  const deny = async (text: string) => {
    await interaction.reply({ components: [moderationReply("Moderation", text)], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  };
  if (!interaction.guildId || !moderationSettings(interaction.guildId).enabled) return deny("Moderation is disabled for this server.");
  if (!canModerate(interaction, action)) return deny(action === "purge" ? "You need permission to purge messages in this channel." : "You do not have permission for this action.");
  const ownerId = interaction.user.id;
  if (messageCommand) {
    const message = interaction.targetMessage;
    if (action === "purge") {
      if (Date.now() - message.createdTimestamp >= maxPurgeAge) return deny("Choose a message less than 14 days old.");
      await interaction.showModal(new ModalBuilder().setTitle("Purge from here")
        .setCustomId(`moderation:purgefrom:${ownerId}:${message.id}:${interaction.id}`)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("Submit to delete the selected message and the newer messages present when you opened this form. The range can include up to 100 messages."))
        .addLabelComponents(shortInput("reason", "Reason", false)));
      return true;
    }
    const modal = moderationModal(action, ownerId, message.author, message.id);
    const customId = `${modal.data.custom_id}:${BigInt(interaction.id).toString(36)}`;
    const expiry = setTimeout(() => pendingMessageText.delete(customId), 15 * 60 * 1000).unref();
    pendingMessageText.set(customId, { text: message.content, expiry });
    try { await interaction.showModal(modal.setCustomId(customId)); }
    catch (error) { takePendingMessageText(customId); throw error; }
    return true;
  }
  if (action === "warnings") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const container = await memberModlogs(interaction, interaction.targetId, ownerId);
    await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
  } else {
    await interaction.showModal(moderationModal(action, ownerId, interaction.targetUser));
  }
  return true;
}

const maxPurgeAge = 14 * 24 * 60 * 60 * 1000;
const maxPurgeMessages = 100;
const purgesInFlight = new Set<string>();

async function purgeFromMessage(channel: GuildTextBasedChannel, startId: string, endId: string) {
  const start = BigInt(startId);
  const recent = await channel.messages.fetch({ before: endId, limit: maxPurgeMessages, cache: false });
  const messages = recent.filter(message => BigInt(message.id) >= start);
  if (messages.size === maxPurgeMessages) {
    const oldest = messages.reduce((earliest, message) => BigInt(message.id) < BigInt(earliest.id) ? message : earliest);
    if (oldest.id !== startId) {
      const previous = await channel.messages.fetch({ before: oldest.id, limit: 1, cache: false });
      if (previous.some(message => BigInt(message.id) >= start)) return null;
    }
  }
  if (messages.size === 1) {
    try { await messages.first()!.delete(); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 10008) return 0;
      throw error;
    }
    return 1;
  }
  return messages.size ? (await channel.bulkDelete([...messages.keys()])).size : 0;
}

export async function handleModerationCommand(interaction: ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction | StringSelectMenuInteraction) {
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    if (!interaction.customId.startsWith("mod-tools:")) return false;
    if (!interaction.guild) return false;
    const [, tool, ownerId, targetId] = interaction.customId.split(":");
    const deny = async (message: string) => { await (interaction.deferred ? interaction.editReply.bind(interaction) : interaction.reply.bind(interaction))({ components: [moderationReply("Moderation", message)], flags: interaction.deferred ? MessageFlags.IsComponentsV2 : MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); return true; };
    if (ownerId !== interaction.user.id) return deny("Use your own /mod command to manage this member.");
    if (interaction.isButton()) {
      if (["logs-page", "warnings-page", "cleared-page"].includes(tool)) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    if (!moderationSettings(interaction.guild.id).enabled) return deny("Moderation is disabled for this server.");
    if (interaction.isStringSelectMenu()) {
      const selected = interaction.values[0];
      if (tool !== "choose" || !["ban", "kick", "timeout"].includes(selected)) return false;
      if (!canModerate(interaction, selected)) return deny("You do not have permission for this action.");
      await interaction.showModal(moderationModal(selected, ownerId, targetId));
      return true;
    }
    if (tool === "logs" || tool === "logs-page" || tool === "warnings-page" || tool === "cleared" || tool === "cleared-page") {
      if (!canModerate(interaction, "warnings")) return deny("You need Moderate Members permission to view modlogs.");
      const requestedPage = tool.endsWith("-page") ? Number(interaction.customId.split(":")[4]) : 0;
      const container = await memberModlogs(interaction, targetId, ownerId, requestedPage, tool === "warnings-page", tool === "cleared" || tool === "cleared-page");
      await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      return true;
    }
    if (tool === "action") {
      const choices = ["ban", "kick", "timeout"].filter(action => canModerate(interaction, action));
      if (!choices.length) return deny("You do not have permission to ban, kick, or timeout members.");
      const menu = new StringSelectMenuBuilder().setCustomId(`mod-tools:choose:${ownerId}:${targetId}`).setPlaceholder("Choose an action").addOptions(choices.map(value => ({ label: actionNames[value], value })));
      const container = moderationReply("Take action", "Choose a punishment, then provide its details.").addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
      await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      return true;
    }
    return false;
  }
  const isModal = interaction.isModalSubmit();
  if (isModal ? !interaction.customId.startsWith("moderation:") : interaction.commandName !== "mod") return false;
  if (!interaction.guild) return false;
  const [, modalAction, ownerId, targetId, messageId] = isModal ? interaction.customId.split(":") : [];
  if (isModal && ownerId !== interaction.user.id) {
    await interaction.reply({ components: [moderationReply("Moderation", "Open your own moderation command to use this form.")], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  }
  const purgeFrom = modalAction === "purgefrom";
  const action = !isModal ? interaction.options.getString("action", true) : purgeFrom ? "purge" : modalAction;
  const permission = permissions[action];
  if (!permission) return false;
  if (!isModal) {
    if (!moderationSettings(interaction.guild.id).enabled || !canModerate(interaction, action)) {
      await interaction.reply({ components: [moderationReply("Moderation", "Moderation is disabled or you do not have permission for this action.")], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    await interaction.showModal(moderationModal(action, interaction.user.id));
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const respond = async (text: string) => { await interaction.editReply({ components: [moderationReply(purgeFrom ? "Purge from here" : actionNames[action], text)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }); return true; };
  const field = (id: string) => interaction.fields.getTextInputValue(id).trim();
  const warningCaseId = action === "clearwarnings" ? Number(field("case-number")) : 0;
  if (action === "clearwarnings" && (!Number.isSafeInteger(warningCaseId) || warningCaseId < 1)) return respond("Enter a valid warning case number.");
  let clearedWarningReason = "";
  const amount = action === "purge" && !purgeFrom ? Number(field("amount")) : 0;
  const minutes = action === "timeout" ? Number(field("minutes")) : 0;
  if (action === "purge" && !purgeFrom && (!Number.isInteger(amount) || amount < 1 || amount > maxPurgeMessages)) return respond("Enter a whole number of messages between 1 and 100.");
  if (action === "timeout" && (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320)) return respond("Enter a whole number of minutes between 1 and 40,320.");
  const guild = interaction.guild, settings = moderationSettings(guild.id);
  if (!settings.enabled) return respond("Moderation is disabled for this server.");
  const actor = await guild.members.fetch(interaction.user.id);
  if (!canModerate(interaction, action)) return respond("You do not have permission to use this command.");
  const me = await guild.members.fetchMe();
  const user = action === "purge" || action === "unban" || targetId ? null : interaction.fields.getSelectedUsers("member", true).first();
  const userId = action === "purge" ? null : targetId || user?.id || (action === "unban" ? field("user-id") : null);
  const suppliedReason = action === "warnings" ? "" : field("reason");
  if (action === "warn" && !suppliedReason) return respond("Enter a reason for this warning.");
  const reason = suppliedReason || "No reason provided";
  if (action !== "purge" && !userId) return respond("Choose a member or enter a user ID.");
  const sourceMessageId = purgeFrom ? targetId : messageId;
  const rawLink = sourceMessageId ? `https://discord.com/channels/${guild.id}/${interaction.channelId}/${sourceMessageId}`
    : memberPunishments.some(({ value }) => value === action) ? field("message-links") : "";
  const messageLinks = rawLink ? [rawLink.replace(/^<(.+)>$/, "$1")] : [];
  const messagePath = messageLinks.length ? discordMessageLinkParts(messageLinks[0]) : null;
  if (messageLinks.length && !messagePath) return respond("Paste one Discord message link using Copy Message Link, or leave the field empty.");
  if (messagePath && messagePath[1] !== guild.id) return respond("That message link belongs to a different server. Copy a message link from this server, or leave the field empty.");
  const auditReason = `${interaction.user.tag}: ${reason}`.slice(0, 512);
  let endBanChange: (() => void) | undefined;
  try {
    if (action === "warnings") {
      const container = await memberModlogs(interaction, userId!, actor.id);
      await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      return true;
    }
    const messageText = !purgeFrom && messagePath
      ? takePendingMessageText(interaction.customId) ?? await readableMessageText(actor, messagePath[2], messagePath[3]) : null;
    let recordedAction = action;
    let actionFailure = "";
    let memberName = user?.username || userId;
    if (userId) {
      if (userId === actor.id || userId === me.id || userId === guild.ownerId) return respond("You cannot moderate yourself, this bot, or the server owner.");
      const banChange = ["ban", "softban", "unban"].includes(action);
      if (banChange) {
        endBanChange = startBanChange(`${guild.id}:${userId}`);
        if (!endBanChange) return respond("A ban action is already in progress for this member.");
      }
      const target = await fetchModerationTarget(interaction, userId, action === "softban");
      memberName = target?.user?.username || memberName;
      if (target && actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) return respond("Your highest role must be above the member's highest role.");
      if (["warn", "timeout", "untimeout", "kick", "softban", "ban"].includes(action) && target && me.roles.highest.comparePositionTo(target.roles.highest) <= 0) return respond("The bot's highest role must be above the member's highest role.");
      if ((["timeout", "untimeout", "kick", "softban"].includes(action) || (action === "warn" && !activeWarningCount(guild.id, userId))) && !target) return respond("That user is not a member of this server.");
      if (action === "timeout" || action === "untimeout") {
        if (!me.permissions.has(permission) || !target!.moderatable) return respond("The bot cannot timeout this member. Check its permissions and the member's roles.");
        await target!.timeout(action === "timeout" ? minutes * 60000 : null, auditReason);
      } else if (action === "kick") {
        if (!me.permissions.has(permission) || !target!.kickable) return respond("The bot cannot kick this member. Check its permissions and roles.");
        await target!.kick(auditReason);
      } else if (banChange) {
        if (action === "unban" && !/^\d{17,20}$/.test(userId)) return respond("Enter a valid Discord user ID.");
        if (!me.permissions.has(permission) || (action !== "unban" && target && !target.bannable)) return respond("Check the bot's Ban Members permission and role order.");
        if (action === "unban") await guild.bans.remove(userId, auditReason);
        else await guild.members.ban(userId, { reason: auditReason, ...(action === "softban" ? { deleteMessageSeconds: softbanDeleteSeconds } : {}) });
        if (action === "softban") {
          try { await guild.bans.remove(userId, `Softban: ${auditReason}`.slice(0, 512)); }
          catch (error) {
            console.error("Softban unban failed", error);
            recordedAction = "ban";
            actionFailure = "The unban failed. The member is still banned.";
          }
        }
        endBanChange?.();
        endBanChange = undefined;
      } else if (action === "clearwarnings") {
        const selectedCase = db.prepare("SELECT action FROM moderation_cases WHERE id=? AND guild_id=? AND user_id=?").get(warningCaseId, guild.id, userId) as { action: string } | undefined;
        if (selectedCase && ["unban", "untimeout", "clearwarnings"].includes(selectedCase.action)) return respond("Unban, remove-timeout, and clear-case records cannot be cleared.");
        const warning = db.prepare("SELECT reason FROM moderation_cases WHERE id=? AND guild_id=? AND user_id=? AND action='warn' AND cleared=0").get(warningCaseId, guild.id, userId) as { reason: string } | undefined;
        if (!warning) return respond("That case is not an active warning for the selected member in this server.");
        const updated = db.prepare("UPDATE moderation_cases SET cleared=1 WHERE id=? AND guild_id=? AND user_id=? AND action='warn' AND cleared=0").run(warningCaseId, guild.id, userId);
        if (!updated.changes) return respond("That warning has already been cleared.");
        clearedWarningReason = warning.reason;
      }
    }
    let result = `${action} completed${memberName ? ` for ${memberName}` : ""}.`;
    if (action === "purge") {
      const channel = interaction.channel;
      if (!channel || !("bulkDelete" in channel) || !("permissionsFor" in channel)) return respond("Use purge in a server text channel.");
      if (!channel.permissionsFor(actor)?.has(P.ManageMessages) && !canModerate(interaction, "purge", false)) return respond("You need Manage Messages permission in this channel.");
      if (!channel.permissionsFor(me)?.has([P.ManageMessages, P.ReadMessageHistory, P.ViewChannel])) return respond("The bot needs View Channel, Read Message History, and Manage Messages here.");
      if (purgesInFlight.has(channel.id)) return respond("A purge is already in progress in this channel.");
      purgesInFlight.add(channel.id);
      try {
        if (purgeFrom) {
          if (Date.now() - SnowflakeUtil.timestampFrom(targetId) >= maxPurgeAge) return respond("Choose a message less than 14 days old.");
          const deleted = await purgeFromMessage(channel, targetId, messageId);
          if (deleted === null) return respond("This range exceeds 100 messages. Choose a newer starting message.");
          if (!deleted) return respond("There are no messages left to delete in this range.");
          result = `Deleted ${deleted} ${deleted === 1 ? "message" : "messages"}.`;
        } else {
          const deleted = await channel.bulkDelete(amount, true);
          result = `Deleted ${deleted.size} message(s). Messages older than 14 days were skipped.`;
        }
      } finally { purgesInFlight.delete(channel.id); }
    }
    if (action === "clearwarnings") result = `Warning case #${warningCaseId} cleared for ${memberName}.`;
    const recordedReason = action === "clearwarnings" ? `Cleared warning case #${warningCaseId}: ${clearedWarningReason}. Clearing reason: ${reason}` : action === "timeout" ? `${reason} · ${minutes} minutes` : action === "purge" ? `${reason} · ${result} · channel ${interaction.channelId}` : actionFailure ? `${reason} - ${actionFailure}` : reason;
    const record = db.prepare("INSERT INTO moderation_cases (guild_id,user_id,moderator_id,action,reason,created_at,message_links,message_text) VALUES (?,?,?,?,?,?,?,?)").run(guild.id, userId, actor.id, recordedAction, recordedReason, new Date().toISOString(), JSON.stringify(messageLinks), messageText);
    const caseId = String(record.lastInsertRowid);
    let escalationStatus = "";
    if (action === "warn" && userId) {
      const count = activeWarningCount(guild.id, userId);
      const rule = warningRules(settings).find(entry => entry.warnings === count);
      escalationStatus = `Active warnings: ${count}.`;
      if (rule) {
        try {
          const punishment = await escalateWarning(guild, actor, userId, count, rule, caseId, auditReason, recordedReason, messageLinks, { messageText });
          escalationStatus += ` Automatic punishment: ${rule.action}${rule.action === "timeout" ? ` for ${rule.minutes} minutes` : ""} completed (case #${punishment.lastInsertRowid}).`;
        } catch (error) {
          escalationStatus += ` Automatic ${rule.action} failed: ${error instanceof Error ? error.message : "Discord rejected the action"}. The warning is still recorded.`;
        }
      }
    }
    const escalationText = escalationStatus ? `\n${escalationStatus}` : "";
    const notificationLabels: Record<string, string> = { warn: "Warning", timeout: "Timeout", untimeout: "Timeout removed", kick: "Kicked", softban: "Removed", ban: "Banned", unban: "Ban removed", clearwarnings: "Warnings cleared" };
    let dmStatus = "";
    if (userId) {
      try {
        const recipient = user || await interaction.client.users.fetch(userId);
        if (action === "clearwarnings") {
          const embed = new EmbedBuilder().setColor(0xf45f77).setDescription(`Warning '${clearedWarningReason}' has been cleared from you`);
          await recipient.send({ embeds: [embed], allowedMentions: { parse: [] } });
        } else if (action === "warn") {
          const embed = new EmbedBuilder().setColor(0xf45f77)
            .setDescription(`You were warned in ${guild.name} for ${reason}${messageLinks.length ? `\n\n${messageLinks.join("\n")}` : ""}`);
          await recipient.send({ embeds: [embed], allowedMentions: { parse: [] } });
        } else {
          const embed = new EmbedBuilder().setColor(0xf45f77)
            .setDescription(`${notificationLabels[recordedAction]} ${["kick", "softban", "ban"].includes(recordedAction) ? "from" : "in"} ${guild.name}.\nReason: ${action === "timeout" ? recordedReason : reason}${recordedAction === "softban" ? "\nYou can rejoin the server." : ""}${messageLinks.length ? `\n\n${messageLinks.join("\n")}` : ""}`);
          await recipient.send({ embeds: [embed], allowedMentions: { parse: [] } });
        }
        dmStatus = "";
      } catch (error) {
        console.error("Moderation DM failed", error);
        dmStatus = "DM could not be delivered (the user may have DMs disabled).";
      }
    }
    let logStatus = "";
    if (settings.log_channel_id) {
      try {
        const channel = await guild.channels.fetch(settings.log_channel_id);
        if (!channel?.isSendable()) throw new Error("Log channel unavailable");
        const logTarget = action === "purge" ? `<#${interaction.channelId}>` : memberName === userId && userId
          ? (await interaction.client.users.fetch(userId).catch(() => null))?.username || userId : memberName;
        const logLabels: Record<string, string> = { warn: "Warn", timeout: "Timeout", kick: "Kick", softban: "Softban", ban: "Ban", unban: "Unban", untimeout: "Timeout removed", clearwarnings: "Case cleared", purge: "Purge" };
        const logReason = action === "clearwarnings" ? `Case #${warningCaseId}: ${clearedWarningReason}` : reason;
        const embed = new EmbedBuilder().setColor(0xf45f77).setDescription([
          `Case #${caseId} - ${logLabels[recordedAction]}: ${logTarget}`,
          `Mod: ${actor.user.username}`,
          `Reason: ${logReason}`,
          action === "timeout" ? `Length: ${minutes} min` : "",
          action === "purge" ? result : "",
          ...messageLinks,
          escalationStatus.includes("Automatic") ? escalationStatus.replace(/^Active warnings: \d+\.\s*/, "") : "",
          actionFailure,
          dmStatus
        ].filter(Boolean).join("\n"));
        await sendLog(guild, channel, "moderation", { embeds: [embed], allowedMentions: { parse: [] } });
        logStatus = "";
      } catch (error) {
        console.error("Moderation log failed", error);
        logStatus = "Log could not be delivered. Check the configured channel and bot permissions.";
      }
    }
    if (["warn", "timeout", "kick", "softban", "ban"].includes(action) && userId) {
      const total = activeWarningCount(guild.id, userId);
      const summaryLabels: Record<string, string> = { warn: "Warned user", timeout: "Timed out user", kick: "Kicked user", softban: "Softbanned user", ban: "Banned user" };
      const duration = action === "timeout" ? `\nLength: ${minutes} minutes` : "";
      const container = moderationReply(actionNames[recordedAction], `Case #${caseId}: ${summaryLabels[recordedAction]} ${memberName}.${duration}${action === "warn" ? `\nTotal warnings: ${total}` : ""}`)
        .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`mod-tools:logs:${actor.id}:${userId}`).setLabel("View modlogs").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`mod-tools:action:${actor.id}:${userId}`).setLabel("Take action").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`mod-tools:cleared:${actor.id}:${userId}`).setLabel("Cleared warnings").setStyle(ButtonStyle.Secondary)
        ));
      const adminDetails = [actionFailure, escalationStatus.includes("Automatic") ? escalationStatus : "", dmStatus, logStatus].filter(Boolean).join("\n");
      if (adminDetails) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(adminDetails));
      await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    } else await respond(`Case #${caseId}: ${result}${escalationText}\n${[dmStatus, logStatus].filter(Boolean).join("\n")}`);
    return true;
  } catch (error) {
    console.error("Moderation action failed", error);
    return respond("The action could not be completed. Check the member, bot permissions, and role order, then try again.");
  } finally { endBanChange?.(); }
}
