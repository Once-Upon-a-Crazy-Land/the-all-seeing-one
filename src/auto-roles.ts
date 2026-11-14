import { PermissionFlagsBits, type Client, type GuildMember, type Role } from "discord.js";
import { db } from "./db.js";
import { premiumStatus } from "./premium.js";

export function maxAutoRoleHours(guildId: string) {
  return (premiumStatus(guildId).active ? 30 : 7) * 24;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS auto_roles (
    guild_id TEXT NOT NULL, role_id TEXT NOT NULL, hours INTEGER,
    PRIMARY KEY (guild_id, role_id)
  );
  CREATE TABLE IF NOT EXISTS auto_role_expirations (
    guild_id TEXT NOT NULL, role_id TEXT NOT NULL, user_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, role_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS auto_role_expirations_due ON auto_role_expirations(expires_at);
`);

const list = db.prepare("SELECT role_id AS roleId, MIN(hours, ?) AS hours FROM auto_roles WHERE guild_id = ?");
const save = db.prepare(`INSERT INTO auto_roles VALUES (?, ?, ?)
  ON CONFLICT(guild_id, role_id) DO UPDATE SET hours = excluded.hours`);
const remove = db.prepare("DELETE FROM auto_roles WHERE guild_id = ? AND role_id = ?");
const track = db.prepare(`INSERT INTO auto_role_expirations VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, role_id, user_id) DO UPDATE SET joined_at = excluded.joined_at, expires_at = excluded.expires_at`);
const due = db.prepare(`SELECT guild_id, role_id, user_id, joined_at, expires_at FROM auto_role_expirations
  WHERE expires_at <= ? ORDER BY expires_at`);
const forget = db.prepare(`DELETE FROM auto_role_expirations
  WHERE guild_id = ? AND role_id = ? AND user_id = ? AND joined_at = ? AND expires_at = ?`);

export function listAutoRoles(guildId: string) {
  const rules = list.all(maxAutoRoleHours(guildId), guildId) as { roleId: string; hours: number | null }[];
  return rules.filter(rule => rule.roleId !== guildId);
}

export function saveAutoRole(guildId: string, roleId: string, hours: number | null | undefined) {
  if (hours === undefined || roleId === guildId) remove.run(guildId, roleId);
  else save.run(guildId, roleId, hours);
}

export function canSetAutoRole(role: Role, actor: GuildMember) {
  return role.id !== actor.guild.id && role.editable &&
    (actor.id === actor.guild.ownerId || actor.roles.highest.comparePositionTo(role) > 0);
}

export async function assignAutoRoles(member: GuildMember) {
  if (member.user.bot) return;
  const { guild, joinedTimestamp } = member;
  for (const { roleId, hours } of listAutoRoles(guild.id)) {
    const role = guild.roles.cache.get(roleId);
    if (!role?.editable || member.roles.cache.has(roleId)) continue;
    if (hours !== null && joinedTimestamp === null) continue;
    try {
      // Track before the Discord request so a successful grant survives a restart.
      if (hours !== null) track.run(guild.id, roleId, member.id, joinedTimestamp!, Date.now() + hours * 3_600_000);
      await member.roles.add(role, "Automatic role on join");
    } catch (error) {
      console.error("Could not assign automatic role", guild.id, roleId, error);
    }
  }
}

export function startAutoRoleExpiry(client: Client<true>) {
  let running = false;
  async function expire() {
    if (running || !client.isReady()) return;
    running = true;
    try {
      for (const row of due.all(Date.now()) as Record<string, string | number>[]) {
        const { guild_id, role_id, user_id, joined_at, expires_at } = row;
        const guild = client.guilds.cache.get(String(guild_id));
        if (!guild?.available) continue;
        try {
          const member = await guild.members.fetch({ user: String(user_id), force: true }).catch(error => {
            if (error.code === 10007) return null;
            throw error;
          });
          if (member?.joinedTimestamp === joined_at && member.roles.cache.has(String(role_id))) {
            if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) continue;
            await member.roles.remove(String(role_id), "Automatic role expired");
          }
          forget.run(guild_id, role_id, user_id, joined_at, expires_at);
        } catch (error) {
          console.error("Could not expire automatic role", guild_id, role_id, error);
        }
      }
    } finally {
      running = false;
    }
  }
  const check = () => void expire().catch(error => console.error("Automatic role expiry failed", error));
  check();
  setInterval(check, 60_000).unref();
}
