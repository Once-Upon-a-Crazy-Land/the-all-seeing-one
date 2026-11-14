import { AttachmentBuilder, ChannelType, PermissionFlagsBits, type GuildBasedChannel, type GuildMember, type PartialGuildMember } from "discord.js";
import { db } from "./db.js";
import { renderMemberCard, type MemberCardKind } from "./level-card.js";

function channelStatements(table: "welcome_settings" | "goodbye_settings") {
  return {
    find: db.prepare("SELECT channel_id FROM " + table + " WHERE guild_id = ?"),
    save: db.prepare("INSERT INTO " + table + " (guild_id, channel_id) VALUES (?, ?) " +
      "ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id"),
    remove: db.prepare("DELETE FROM " + table + " WHERE guild_id = ?")
  };
}

const channels = { welcome: channelStatements("welcome_settings"), goodbye: channelStatements("goodbye_settings") };

export function memberCardChannelId(guildId: string, kind: MemberCardKind) {
  return (channels[kind].find.get(guildId) as { channel_id: string } | undefined)?.channel_id ?? null;
}

export function setMemberCardChannel(guildId: string, kind: MemberCardKind, channelId: string | null) {
  if (channelId) channels[kind].save.run(guildId, channelId);
  else channels[kind].remove.run(guildId);
}

export function isWelcomeChannel(channel: GuildBasedChannel | null) {
  return channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildAnnouncement;
}

export function canSendWelcome(channel: GuildBasedChannel | null, botMember: GuildMember) {
  return isWelcomeChannel(channel) && channel.permissionsFor(botMember).has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles
  ]);
}

export async function renderGuildMemberCard(member: GuildMember | PartialGuildMember, kind: MemberCardKind) {
  const profile = await member.user.fetch(true).catch(() => member.user);
  const nameplate = member.collectibles?.nameplate ?? profile.collectibles?.nameplate;
  return renderMemberCard({
    username: member.displayName,
    avatarUrl: (member.partial ? profile : member).displayAvatarURL({ extension: "png", size: 256 }),
    avatarDecorationUrl: member.avatarDecorationURL() ?? profile.avatarDecorationURL({ size: 256 }),
    nameplateUrl: nameplate ? `https://cdn.discordapp.com/assets/collectibles/${nameplate.asset}static.png` : null,
    accentColor: profile.accentColor,
    bannerUrl: profile.bannerURL({ extension: "png", size: 512 })
  }, member.guild.name, kind);
}

export async function sendMemberCard(member: GuildMember | PartialGuildMember, kind: MemberCardKind) {
  if (member.user.bot) return;
  const guild = member.guild;
  const channelId = memberCardChannelId(guild.id, kind);
  if (!channelId) return;
  const [channel, botMember] = await Promise.all([
    guild.channels.fetch(channelId),
    guild.members.fetchMe()
  ]);
  if (!isWelcomeChannel(channel) || !canSendWelcome(channel, botMember)) return;
  const image = await renderGuildMemberCard(member, kind);
  if (memberCardChannelId(guild.id, kind) !== channelId) return;
  await channel.send({
    files: [new AttachmentBuilder(image, {
      name: `${kind}-${member.id}.png`,
      description: kind === "goodbye"
        ? `${member.displayName} left ${guild.name}.`
        : `Welcome to ${guild.name}, ${member.displayName}!`
    })],
    allowedMentions: { parse: [] }
  });
}
