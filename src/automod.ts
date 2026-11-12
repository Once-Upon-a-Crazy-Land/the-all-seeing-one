import {
  AutoModerationActionType as Action, AutoModerationRuleEventType as Event,
  AutoModerationRuleTriggerType as Trigger, DiscordAPIError, EmbedBuilder,
  PermissionFlagsBits as P, type AutoModerationActionExecution,
  type AutoModerationActionOptions, type AutoModerationRule, type Guild
} from "discord.js";
import { db } from "./db.js";
import { sendLog } from "./log-webhooks.js";
import { moderationSettings, recordAutoModCase, recordAutoModTimeout } from "./moderation.js";

db.exec(`CREATE TABLE IF NOT EXISTS automod_rules (
  guild_id TEXT NOT NULL, rule_id TEXT NOT NULL, warning_actor_id TEXT,
  PRIMARY KEY (guild_id, rule_id)
)`);

const storedRule = db.prepare("SELECT warning_actor_id FROM automod_rules WHERE guild_id=? AND rule_id=?");
const saveRule = db.prepare("INSERT INTO automod_rules VALUES (?,?,?) ON CONFLICT(guild_id,rule_id) DO UPDATE SET warning_actor_id=excluded.warning_actor_id");
const forgetRule = db.prepare("DELETE FROM automod_rules WHERE guild_id=? AND rule_id=?");

export class AutoModError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function autoModError(error: unknown) {
  if (error instanceof AutoModError) return error;
  if (error instanceof DiscordAPIError) {
    if (error.status === 403) return new AutoModError("Crazyland needs Manage Server and access to the selected alert channel.", 403);
    if (error.status === 404) return new AutoModError("Discord could not find the rule or a selected channel. Reload and try again.", 404);
    if (error.status === 400) return new AutoModError("Discord rejected the rule. Check the patterns, exemptions, and available rule slots.");
  }
  console.error("AutoMod request failed", error);
  return new AutoModError("Could not reach Discord AutoMod. Try again.", 502);
}

function describeRule(rule: AutoModerationRule) {
  const settings = storedRule.get(rule.guild.id, rule.id);
  return {
    id: rule.id, name: rule.name, type: rule.triggerType, enabled: rule.enabled,
    managed: !!settings && rule.creatorId === rule.client.user.id,
    warn: !!settings?.warning_actor_id,
    keywords: rule.triggerMetadata.keywordFilter,
    patterns: rule.triggerMetadata.regexPatterns,
    allowList: rule.triggerMetadata.allowList,
    presets: rule.triggerMetadata.presets,
    mentionLimit: rule.triggerMetadata.mentionTotalLimit,
    raidProtection: rule.triggerMetadata.mentionRaidProtectionEnabled,
    exemptRoles: [...rule.exemptRoles.keys()],
    exemptChannels: [...rule.exemptChannels.keys()],
    alertChannel: rule.actions.find(action => action.type === Action.SendAlertMessage)?.metadata.channelId,
    timeoutMinutes: (rule.actions.find(action => action.type === Action.Timeout)?.metadata.durationSeconds ?? 0) / 60,
    blockMessage: rule.actions.find(action => action.type === Action.BlockMessage)?.metadata.customMessage
  };
}

export async function listAutoModRules(guild: Guild) {
  return (await guild.autoModerationRules.fetch()).map(describeRule);
}

async function managedRule(guild: Guild, id: string) {
  if (!/^\d{17,20}$/.test(id) || !storedRule.get(guild.id, id)) throw new AutoModError("Crazyland rule not found.", 404);
  const rule = await guild.autoModerationRules.fetch({ autoModerationRule: id, force: true });
  if (rule.creatorId !== guild.client.user.id) throw new AutoModError("Crazyland rule not found.", 404);
  return rule;
}

function entries(value: unknown, count: number, length: number, label: string) {
  if (!Array.isArray(value) || value.length > count || value.some(item => typeof item !== "string" || !item.trim() || item.length > length)) {
    throw new AutoModError(`Use up to ${count} ${label}, with up to ${length} characters each.`);
  }
  return [...new Set<string>(value)];
}

export async function writeAutoModRule(guild: Guild, actorId: string, body: Record<string, unknown>, id?: string) {
  if (!body || typeof body !== "object") throw new AutoModError("Enter the rule settings.");
  const actor = await guild.members.fetch({ user: actorId, force: true }).catch(() => null);
  if (!actor?.permissions.has(P.ManageGuild)) throw new AutoModError("Manage Server permission required.", 403);
  if (body.warn === true && !actor.permissions.has(P.ModerateMembers)) throw new AutoModError("Moderate Members permission is required to issue warnings.", 403);
  const existing = id ? await managedRule(guild, id) : null;
  const type = existing?.triggerType ?? body.type;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) throw new AutoModError("Enter a rule name up to 100 characters.");
  const blockMessage = typeof body.blockMessage === "string" ? body.blockMessage.trim() : "";
  if (blockMessage.length > 150) throw new AutoModError("Use up to 150 characters for the block message.");

  let triggerMetadata;
  switch (type) {
    case Trigger.Keyword: {
      const keywordFilter = entries(body.keywords, 1000, 60, "keywords");
      const regexPatterns = entries(body.patterns, 10, 260, "regex patterns");
      if (!keywordFilter.length && !regexPatterns.length) throw new AutoModError("Enter at least one keyword or regex pattern.");
      triggerMetadata = { keywordFilter, regexPatterns, allowList: entries(body.allowList, 100, 60, "allowed phrases") };
      break;
    }
    case Trigger.KeywordPreset: {
      const presets = body.presets;
      if (!Array.isArray(presets) || !presets.length || presets.some(value => ![1, 2, 3].includes(value))) {
        throw new AutoModError("Choose at least one word list.");
      }
      triggerMetadata = { presets: [...new Set(presets)], allowList: entries(body.allowList, 1000, 60, "allowed phrases") };
      break;
    }
    case Trigger.MentionSpam:
      if (typeof body.mentionLimit !== "number" || !Number.isInteger(body.mentionLimit) || body.mentionLimit < 1 || body.mentionLimit > 50) {
        throw new AutoModError("Enter a mention limit between 1 and 50.");
      }
      triggerMetadata = { mentionTotalLimit: body.mentionLimit, mentionRaidProtectionEnabled: body.raidProtection === true };
      break;
    case Trigger.Spam:
      break;
    default:
      throw new AutoModError("Choose a supported rule type.");
  }

  const exemptRoles = entries(body.exemptRoles, 20, 20, "exempt roles");
  const exemptChannels = entries(body.exemptChannels, 50, 20, "exempt channels");
  if (exemptRoles.some(roleId => roleId === guild.id || !guild.roles.cache.has(roleId))) throw new AutoModError("Choose roles from this server.");
  if (exemptChannels.some(channelId => !guild.channels.cache.has(channelId))) throw new AutoModError("Choose channels from this server.");

  const actions: AutoModerationActionOptions[] = [{ type: Action.BlockMessage, metadata: blockMessage ? { customMessage: blockMessage } : undefined }];
  if (body.alertChannel) {
    const channel = typeof body.alertChannel === "string" ? guild.channels.cache.get(body.alertChannel) : null;
    if (!channel?.isSendable()) throw new AutoModError("Choose a server channel for Discord alerts.");
    const me = await guild.members.fetchMe();
    if (!channel.permissionsFor(actor).has([P.ViewChannel, P.SendMessages]) || !channel.permissionsFor(me).has([P.ViewChannel, P.SendMessages])) {
      throw new AutoModError("You and Crazyland need View Channel and Send Messages in the alert channel.");
    }
    actions.push({ type: Action.SendAlertMessage, metadata: { channel: channel.id } });
  }
  const timeout = body.timeoutMinutes ?? 0;
  if (timeout !== 0) {
    if (type !== Trigger.Keyword && type !== Trigger.MentionSpam) throw new AutoModError("Discord timeouts require a keyword or mention rule.");
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 40320) {
      throw new AutoModError("Enter a timeout between 1 and 40,320 whole minutes.");
    }
    if (!actor.permissions.has(P.ModerateMembers) || !(await guild.members.fetchMe()).permissions.has(P.ModerateMembers)) {
      throw new AutoModError("You and Crazyland need Moderate Members for Discord timeouts.", 403);
    }
    actions.push({ type: Action.Timeout, metadata: { durationSeconds: timeout * 60 } });
  }

  const reason = `Crazyland dashboard by ${actorId}`;
  const options = { name, eventType: Event.MessageSend, triggerMetadata, exemptRoles, exemptChannels, actions, reason };
  // Register new rules before enabling them so the first block can be recorded.
  const rule = existing ?? await guild.autoModerationRules.create({ ...options, triggerType: type, enabled: false });
  if (!existing) saveRule.run(guild.id, rule.id, body.warn === true ? actorId : null);
  const enabled = body.enabled === true;
  let saved = rule;
  if (existing || enabled) {
    try {
      saved = await rule.edit(existing ? { ...options, enabled } : { enabled, reason });
    } catch (error) {
      if (existing) throw error;
      const failure = autoModError(error);
      throw new AutoModError(`Rule created, but enabling it failed. ${failure.message} Reload AutoMod to edit the saved rule.`, failure.status);
    }
  }
  saveRule.run(guild.id, saved.id, body.warn === true ? actorId : null);
  return describeRule(saved);
}

export async function deleteAutoModRule(guild: Guild, actorId: string, id: string) {
  const actor = await guild.members.fetch({ user: actorId, force: true }).catch(() => null);
  if (!actor?.permissions.has(P.ManageGuild)) throw new AutoModError("Manage Server permission required.", 403);
  const rule = await managedRule(guild, id);
  await rule.delete(`Crazyland dashboard by ${actorId}`);
  forgetRule.run(guild.id, id);
}

async function eligibleWarningActor(execution: AutoModerationActionExecution, actorId: string) {
  const { guild, userId } = execution;
  if (userId === actorId || userId === guild.ownerId || userId === guild.client.user.id) return null;
  const actor = await guild.members.fetch({ user: actorId, force: true }).catch(() => null);
  if (!actor?.permissions.has([P.ManageGuild, P.ModerateMembers])) return null;
  const target = execution.member ?? await guild.members.fetch(userId).catch(() => null);
  if (!target || (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)) return null;
  const me = guild.members.me ?? await guild.members.fetchMe();
  return me.roles.highest.comparePositionTo(target.roles.highest) > 0 ? actor : null;
}

export async function handleAutoModAction(execution: AutoModerationActionExecution) {
  const { guild, action, ruleId, userId, channelId } = execution;
  if (action.type !== Action.BlockMessage && action.type !== Action.Timeout) return;
  const ruleSettings = storedRule.get(guild.id, ruleId);
  if (!ruleSettings) return;
  const settings = moderationSettings(guild.id);
  if (!settings.enabled) return;
  const rule = execution.autoModerationRule ?? await guild.autoModerationRules.fetch(ruleId).catch(() => null);
  const reason = `triggering AutoMod rule "${rule?.name || ruleId}"`;
  const actor = action.type === Action.BlockMessage && typeof ruleSettings.warning_actor_id === "string"
    ? await eligibleWarningActor(execution, ruleSettings.warning_actor_id) : null;
  const result = action.type === Action.Timeout
    ? recordAutoModTimeout(guild, userId, reason, (action.metadata.durationSeconds ?? 0) / 60)
    : await recordAutoModCase(guild, userId, reason, settings, actor);
  if (!settings.log_channel_id) return;
  const channel = await guild.channels.fetch(settings.log_channel_id);
  if (!channel?.isSendable()) throw new Error("Moderation log channel unavailable");
  const user = execution.user ?? await guild.client.users.fetch(userId).catch(() => null);
  const label = action.type === Action.Timeout ? "AutoMod timeout" : actor ? "AutoMod warning" : "AutoMod block";
  const details = [
    `Case #${result.caseId} - ${label}: ${user?.username ?? userId}`,
    "Mod: Discord AutoMod",
    `Reason: ${reason}`,
    channelId ? `Channel: <#${channelId}>` : "",
    result.detail
  ].filter(Boolean).join("\n");
  await sendLog(guild, channel, "moderation", {
    embeds: [new EmbedBuilder().setColor(0xf45f77).setDescription(details)],
    allowedMentions: { parse: [] }
  });
}
