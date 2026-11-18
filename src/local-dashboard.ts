import { mkdirSync } from "node:fs";
import { ChannelType, Collection, type Guild } from "discord.js";

mkdirSync("data", { recursive: true });
const port = process.env.PORT ?? "3000";
const previewPremium = process.env.LOCAL_PREMIUM_PREVIEW === "1";
const previewSku = "100000000000000003";
Object.assign(process.env, {
  PORT: port,
  DATABASE_PATH: previewPremium ? ":memory:" : "./data/local-dashboard.db",
  DISCORD_REDIRECT_URI: `http://localhost:${port}/auth/discord/callback`,
  DISCORD_TOKEN: "local",
  DISCORD_CLIENT_ID: "100000000000000000",
  DISCORD_CLIENT_SECRET: "local",
  DISCORD_PREMIUM_SKU_ID: previewPremium ? previewSku : "",
  SESSION_SECRET: "local-dashboard",
  PAYPAL_CLIENT_ID: "",
  PAYPAL_CLIENT_SECRET: "",
  PAYPAL_PLAN_ID: "",
  PAYPAL_WEBHOOK_ID: ""
});

const { startWeb } = await import("./web.js");
const previewServers = [
  { id: "100000000000000001", name: "Local Test Server", memberCount: 18 },
  { id: "100000000000000101", name: "Economy Workshop", memberCount: 42 },
  { id: "100000000000000201", name: "Creator Studio", memberCount: 7 }
];

if (previewPremium) {
  const { db, ensureDefaultSystem, ensureDefaultEconomySystem } = await import("./db.js");
  const previewUser = "100000000000000002";
  for (const { id } of previewServers) {
    ensureDefaultSystem(id);
    ensureDefaultEconomySystem(id);
    for (const name of ["Second System", "Premium Test System"]) {
      db.prepare("INSERT INTO leveling_systems (guild_id, name) VALUES (?, ?)").run(id, name);
      db.prepare("INSERT INTO economy_systems (guild_id, name) VALUES (?, ?)").run(id, name);
    }
  }
  db.prepare("INSERT INTO discord_premium_subscribers VALUES (?, ?, ?)").run(previewSku, previewUser, Number.MAX_SAFE_INTEGER);
  db.prepare("INSERT INTO discord_premium_assignments VALUES (?, ?, ?)").run(previewSku, previewUser, previewServers[0].id);
}

startWeb(previewServers.map(server => {
  const prefix = server.id.slice(0, -2);
  const channels = ["general", "announcements", "mod-log"].map((name, index) => ({
    id: `${prefix}1${index}`, name, type: ChannelType.GuildText, rawPosition: index,
    parentId: null, isTextBased: () => true, isThread: () => false
  }));
  const roles = ["Member", "Regular", "Moderator"].map((name, index) => ({
    id: `${prefix}2${index}`, name, position: index + 1, managed: false,
    hexColor: ["#99aab5", "#57f287", "#5865f2"][index]
  }));
  return {
    ...server,
    icon: null,
    channels: { cache: new Collection(channels.map(channel => [channel.id, channel])), fetch: async () => null },
    roles: { cache: new Collection(roles.map(role => [role.id, role])) },
    emojis: { cache: new Collection() },
    members: { cache: new Collection() },
    autoModerationRules: { fetch: async () => new Collection() }
  } as unknown as Guild;
}));
