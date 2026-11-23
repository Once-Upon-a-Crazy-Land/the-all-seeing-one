import { type Client, type Guild, PermissionFlagsBits, ChannelType, MessageFlags } from "discord.js";
import { db } from "./db.js";
import { composeV2Container } from "./embed-composer.js";
import { premiumStatus } from "./premium.js";
import { config } from "./config.js";

const platforms = ["youtube", "twitch", "instagram", "tiktok"] as const;
type Platform = typeof platforms[number];
type Post = { id: string; title: string; url: string; time: number; previewUrl?: string };
type InstagramMedia = { media_type?: string; media_url?: string; thumbnail_url?: string };
const uploadedAvatarPrefix = "data:image/png;base64,";
type Alert = {
  id: number; guild_id: string; platform: Platform; account: string; profile: string; channel_id: string;
  message: string; name: string; avatar: string; started: number; error: string;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS creator_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, platform TEXT NOT NULL, account TEXT NOT NULL, profile TEXT NOT NULL,
    channel_id TEXT NOT NULL, message TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL,
    started INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '',
    UNIQUE(guild_id, platform, account, channel_id)
  );
  CREATE TABLE IF NOT EXISTS creator_alert_sent (
    alert_id INTEGER NOT NULL REFERENCES creator_alerts(id) ON DELETE CASCADE,
    post_id TEXT NOT NULL, PRIMARY KEY(alert_id, post_id)
  );
  CREATE TABLE IF NOT EXISTS creator_alert_webhooks (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS creator_alert_platform_avatars (
    guild_id TEXT NOT NULL, platform TEXT NOT NULL, avatar TEXT NOT NULL,
    PRIMARY KEY(guild_id, platform)
  );
  CREATE TABLE IF NOT EXISTS creator_alert_platform_colors (
    guild_id TEXT NOT NULL, platform TEXT NOT NULL, color TEXT NOT NULL,
    PRIMARY KEY(guild_id, platform)
  );
  CREATE TABLE IF NOT EXISTS creator_alert_tiktok (
    account TEXT PRIMARY KEY, access TEXT NOT NULL, refresh TEXT NOT NULL, expires INTEGER NOT NULL
  );
`);

if (!db.prepare("PRAGMA table_info(creator_alerts)").all().some(column => column.name === "profile")) {
  db.exec("ALTER TABLE creator_alerts ADD COLUMN profile TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE creator_alerts SET profile = account WHERE profile = ''");
}

const labels: Record<Platform, string> = { youtube: "YouTube", twitch: "Twitch", instagram: "Instagram", tiktok: "TikTok" };
export const creatorPlatformColorDefaults: Record<Platform, string> = {
  youtube: "#ff0000",
  twitch: "#9146ff",
  instagram: "#e1306c",
  tiktok: "#25f4ee"
};

function credential(name: string, platform: Platform) {
  const value = process.env[name];
  if (!value) throw new Error(labels[platform] + " is not configured on the bot.");
  return value;
}

async function json<T>(url: URL | string, label: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) })
    .catch(() => { throw new Error(label + " could not be reached."); });
  if (!response.ok) throw new Error(label + " rejected the request (" + response.status + ").");
  return response.json() as Promise<T>;
}

function endpoint(base: string, params: Record<string, string>) {
  const url = new URL(base);
  url.search = new URLSearchParams(params).toString();
  return url;
}

function accountName(platform: Platform, input: string) {
  let account = input.trim();
  if (/^https?:\/\//i.test(account)) {
    const url = new URL(account);
    if (url.hostname.replace(/^(www\.|m\.)/, "") !== platform + ".com") throw new Error("Enter a profile URL for the selected platform.");
    const parts = url.pathname.split("/").filter(Boolean);
    account = platform === "youtube" && parts[0] === "channel" ? parts[1] ?? "" : parts[0] ?? "";
  }
  account = account.replace(/^@/, "");
  if (!/^[a-z0-9_.-]{1,100}$/i.test(account)) throw new Error("Enter a valid profile URL or handle.");
  return platform === "youtube" && /^UC[\w-]{22}$/.test(account) ? account : account.toLowerCase();
}

async function youtube(account: string): Promise<Post[]> {
  const key = credential("YOUTUBE_API_KEY", "youtube");
  const base = "https://www.googleapis.com/youtube/v3/";
  const filter: Record<string, string> = /^UC[\w-]{22}$/.test(account) ? { id: account } : { forHandle: account };
  const channels = await json<{ items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[] }>(
    endpoint(base + "channels", { part: "contentDetails", key, ...filter }), "YouTube"
  );
  const playlistId = channels.items?.[0]?.contentDetails.relatedPlaylists.uploads;
  if (!playlistId) throw new Error("YouTube channel not found.");
  const result = await json<{ items: {
    snippet: { title: string; thumbnails?: Record<string, { url: string }> };
    contentDetails: { videoId: string; videoPublishedAt?: string };
  }[] }>(
    endpoint(base + "playlistItems", { part: "snippet,contentDetails", playlistId, maxResults: "50", key }), "YouTube"
  );
  return result.items.map(({ snippet, contentDetails }) => {
    const images = snippet.thumbnails;
    return {
      id: contentDetails.videoId, title: snippet.title, url: "https://www.youtube.com/watch?v=" + contentDetails.videoId,
      time: Date.parse(contentDetails.videoPublishedAt ?? ""),
      previewUrl: images?.maxres?.url ?? images?.standard?.url ?? images?.high?.url ?? images?.medium?.url ?? images?.default?.url
    };
  });
}

let twitchToken: { access_token: string; expires: number } | undefined;
async function twitch(account: string, verify: boolean): Promise<Post[]> {
  const clientId = credential("TWITCH_CLIENT_ID", "twitch");
  if (!twitchToken || Date.now() >= twitchToken.expires) {
    const clientSecret = credential("TWITCH_CLIENT_SECRET", "twitch");
    const token = await json<{ access_token: string; expires_in: number }>("https://id.twitch.tv/oauth2/token", "Twitch", {
      method: "POST", body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" })
    });
    twitchToken = { ...token, expires: Date.now() + (token.expires_in - 60) * 1000 };
  }
  const options = { headers: { "Client-Id": clientId, Authorization: "Bearer " + twitchToken.access_token } };
  if (verify) {
    const users = await json<{ data: unknown[] }>(endpoint("https://api.twitch.tv/helix/users", { login: account }), "Twitch", options);
    if (!users.data.length) throw new Error("Twitch channel not found.");
  }
  const result = await json<{ data: { id: string; title: string; started_at: string; thumbnail_url?: string }[] }>(
    endpoint("https://api.twitch.tv/helix/streams", { user_login: account }), "Twitch", options
  );
  return result.data.map(item => ({
    id: item.id, title: item.title, url: "https://www.twitch.tv/" + account, time: Date.parse(item.started_at),
    previewUrl: item.thumbnail_url?.replace("{width}", "640").replace("{height}", "360")
  }));
}

async function instagram(account: string): Promise<Post[]> {
  const id = credential("INSTAGRAM_ACCOUNT_ID", "instagram");
  const version = credential("INSTAGRAM_GRAPH_VERSION", "instagram");
  const token = credential("INSTAGRAM_ACCESS_TOKEN", "instagram");
  const result = await json<{ business_discovery?: { media?: { data?: (InstagramMedia & {
    id: string; caption?: string; permalink: string; timestamp: string; children?: { data?: InstagramMedia[] };
  })[] } } }>(
    endpoint(`https://graph.facebook.com/${version}/${id}`, {
      fields: `business_discovery.username(${account}){media.limit(50){id,caption,permalink,timestamp,media_type,media_url,thumbnail_url,children.limit(1){media_type,media_url,thumbnail_url}}}`,
      access_token: token
    }), "Instagram"
  );
  if (!result.business_discovery) throw new Error("Instagram professional account not found.");
  return (result.business_discovery.media?.data ?? []).map(item => {
    const cover = item.children?.data?.[0] ?? item;
    return {
      id: item.id, title: item.caption ?? "", url: item.permalink, time: Date.parse(item.timestamp),
      previewUrl: cover.media_type === "VIDEO" ? cover.thumbnail_url : cover.media_url ?? item.media_url
    };
  });
}

const tokenRequests = new Map<string, Promise<string>>();
async function refreshTikTok(account: string) {
  const stored = db.prepare("SELECT * FROM creator_alert_tiktok WHERE account = ?").get(account) as
    { access: string; refresh: string; expires: number } | undefined;
  if (stored && stored.expires > Date.now()) return stored.access;
  const seeds = JSON.parse(process.env.TIKTOK_CREATOR_REFRESH_TOKENS || "{}") as Record<string, string>;
  const refresh = stored?.refresh ?? (Object.hasOwn(seeds, account) ? seeds[account] : "");
  if (!refresh) throw new Error("This TikTok creator must authorize the app before tracking can start.");
  const token = await json<{ access_token?: string; refresh_token?: string; expires_in: number }>(
    "https://open.tiktokapis.com/v2/oauth/token/", "TikTok", {
      method: "POST", body: new URLSearchParams({
        client_key: credential("TIKTOK_CLIENT_KEY", "tiktok"), client_secret: credential("TIKTOK_CLIENT_SECRET", "tiktok"),
        grant_type: "refresh_token", refresh_token: refresh
      })
    }
  );
  if (!token.access_token || !token.refresh_token) throw new Error("TikTok authorization could not be refreshed.");
  db.prepare(`INSERT INTO creator_alert_tiktok VALUES (?, ?, ?, ?)
    ON CONFLICT(account) DO UPDATE SET access = excluded.access, refresh = excluded.refresh, expires = excluded.expires`)
    .run(account, token.access_token, token.refresh_token, Date.now() + (token.expires_in - 60) * 1000);
  return token.access_token;
}

async function tiktok(account: string): Promise<Post[]> {
  let pending = tokenRequests.get(account);
  if (!pending) {
    pending = refreshTikTok(account).finally(() => tokenRequests.delete(account));
    tokenRequests.set(account, pending);
  }
  const token = await pending;
  const result = await json<{ data?: { videos?: {
    id: string; title?: string; share_url: string; create_time: number; cover_image_url?: string;
  }[] }; error?: { code: string } }>(
    "https://open.tiktokapis.com/v2/video/list/?fields=id,title,share_url,create_time,cover_image_url", "TikTok", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ max_count: 20 })
    }
  );
  if (result.error?.code !== "ok" || !result.data) throw new Error("TikTok could not list this creator's videos.");
  return (result.data.videos ?? []).map(item => ({
    id: item.id, title: item.title || "New TikTok video", url: item.share_url, time: item.create_time * 1000,
    previewUrl: item.cover_image_url
  }));
}

function posts(platform: Platform, account: string, verify = false) {
  if (platform === "youtube") return youtube(account);
  if (platform === "twitch") return twitch(account, verify);
  if (platform === "instagram") return instagram(account);
  return tiktok(account);
}

export function listCreatorAlerts(guildId: string) {
  const { creatorAlertLimit } = premiumStatus(guildId);
  return db.prepare("SELECT id, platform, account, profile, channel_id, message, name, avatar, error FROM creator_alerts WHERE guild_id = ? ORDER BY id")
    .all(guildId).map((alert, index) => ({ ...alert, premiumPaused: index >= creatorAlertLimit }));
}

function creatorAlertAvailable(guildId: string, id: number) {
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM creator_alerts WHERE guild_id = ? AND id < ?")
    .get(guildId, id) as { count: number };
  return count < premiumStatus(guildId).creatorAlertLimit;
}

export function listCreatorPlatformAvatars(guildId: string) {
  const rows = db.prepare("SELECT platform, avatar FROM creator_alert_platform_avatars WHERE guild_id = ?")
    .all(guildId) as { platform: Platform; avatar: string }[];
  return Object.fromEntries(rows.map(({ platform, avatar }) => [platform, avatar]));
}

export function listCreatorPlatformColors(guildId: string) {
  const rows = db.prepare("SELECT platform, color FROM creator_alert_platform_colors WHERE guild_id = ? AND color <> ''")
    .all(guildId) as { platform: Platform; color: string }[];
  return Object.fromEntries(rows.map(({ platform, color }) => [platform, color]));
}

export function saveCreatorPlatformColor(guildId: string, platform: string, value: unknown) {
  if (!platforms.includes(platform as Platform)) throw new Error("Choose a platform.");
  if (value !== null && (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))) {
    throw new Error("Choose a valid embed color.");
  }
  const color = value?.toLowerCase() ?? null;
  if (color === null) {
    db.prepare("DELETE FROM creator_alert_platform_colors WHERE guild_id = ? AND platform = ?").run(guildId, platform);
  } else {
    db.prepare(`INSERT INTO creator_alert_platform_colors (guild_id, platform, color) VALUES (?, ?, ?)
      ON CONFLICT(guild_id, platform) DO UPDATE SET color = excluded.color`).run(guildId, platform, color);
  }
  return color;
}

export function saveCreatorPlatformAvatar(guildId: string, platform: string, value: unknown) {
  if (!platforms.includes(platform as Platform)) throw new Error("Choose a platform.");
  if (typeof value !== "string") throw new Error("Enter an HTTPS avatar URL or upload an image.");
  const avatar = validateCreatorAvatar(value);
  if (!premiumStatus(guildId).active) throw new Error("Custom webhook avatars require Premium.");
  if (avatar) {
    db.prepare(`INSERT INTO creator_alert_platform_avatars (guild_id, platform, avatar) VALUES (?, ?, ?)
      ON CONFLICT(guild_id, platform) DO UPDATE SET avatar = excluded.avatar`).run(guildId, platform, avatar);
  } else {
    db.prepare("DELETE FROM creator_alert_platform_avatars WHERE guild_id = ? AND platform = ?").run(guildId, platform);
  }
  return avatar;
}

function effectiveCreatorAvatar(alert: Alert): string {
  if (alert.avatar) return alert.avatar;
  const fallback = db.prepare("SELECT avatar FROM creator_alert_platform_avatars WHERE guild_id = ? AND platform = ?")
    .get(alert.guild_id, alert.platform) as { avatar: string } | undefined;
  return fallback?.avatar ?? "";
}

export function deleteCreatorAlert(guildId: string, id: number) {
  return db.prepare("DELETE FROM creator_alerts WHERE guild_id = ? AND id = ?").run(guildId, id).changes > 0;
}

async function destination(guild: Guild, channelId: string, local = false) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    throw new Error("Choose a text or announcement channel in this server.");
  }
  if (!local) {
    const me = await guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageWebhooks])) {
      throw new Error("The bot needs View Channel and Manage Webhooks in the destination channel.");
    }
  }
  return channel;
}

function validateCreatorAvatar(value: string) {
  const avatar = value.trim();
  if (avatar.startsWith(uploadedAvatarPrefix)) {
    const encoded = avatar.slice(uploadedAvatarPrefix.length);
    const invalidImage = () => new Error("Upload a valid avatar image.");
    if (encoded.length > 90_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw invalidImage();
    const png = Buffer.from(encoded, "base64");
    if (png.length < 33 || png.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
      png.toString("ascii", 12, 16) !== "IHDR" || png.toString("base64") !== encoded ||
      png.readUInt32BE(16) !== 128 || png.readUInt32BE(20) !== 128) throw invalidImage();
  } else if (avatar) {
    let url: URL;
    try { url = new URL(avatar); } catch { throw new Error("Enter a valid HTTPS avatar URL."); }
    if (url.protocol !== "https:" || url.username || url.password || avatar.length > 2048) throw new Error("Enter a valid HTTPS avatar URL.");
  }
  return avatar;
}

export async function saveCreatorAlert(guild: Guild, body: Record<string, unknown>, local: boolean, id?: number) {
  const platform = body.platform as Platform;
  if (!platforms.includes(platform)) throw new Error("Choose a platform.");
  const profile = typeof body.account === "string" ? body.account.trim() : "";
  if (profile.length > 300) throw new Error("Enter a valid profile URL or handle.");
  const account = accountName(platform, profile);
  const channelId = typeof body.channelId === "string" ? body.channelId : "";
  const message = typeof body.message === "string" ? body.message : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!message.trim() || message.length > 2000) throw new Error("Enter alert text between 1 and 2,000 characters.");
  if (name.length > 80 || (name.length > 0 && name.length < 2) || /discord|clyde/i.test(name)) {
    throw new Error("Use a webhook name between 2 and 80 characters without Discord or Clyde.");
  }
  const avatar = validateCreatorAvatar(typeof body.avatar === "string" ? body.avatar : "");
  const previous = id === undefined ? undefined : db.prepare("SELECT * FROM creator_alerts WHERE guild_id = ? AND id = ?").get(guild.id, id) as Alert | undefined;
  if (id !== undefined && !previous) throw new Error("This alert no longer exists.");
  if (!premiumStatus(guild.id).active && avatar !== (previous?.avatar ?? "")) {
    throw new Error("Changing custom webhook avatars requires Premium.");
  }
  const limitError = (limit: number) => new Error(`This server has reached its limit of ${limit} Creator Alerts. Remove alerts until you are below the limit.`);
  if (!previous) {
    const { creatorAlertLimit } = premiumStatus(guild.id);
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM creator_alerts WHERE guild_id = ?").get(guild.id) as { count: number };
    if (count >= creatorAlertLimit) throw limitError(creatorAlertLimit);
  }
  await destination(guild, channelId, local);
  const sourceChanged = !previous || previous.platform !== platform || previous.account !== account;
  if (!local && sourceChanged) await posts(platform, account, true);
  const duplicate = db.prepare("SELECT id FROM creator_alerts WHERE guild_id = ? AND platform = ? AND account = ? AND channel_id = ?")
    .get(guild.id, platform, account, channelId);
  if (duplicate && duplicate.id !== id) throw new Error("This account is already tracked in that channel.");
  if (!previous) {
    const { creatorAlertLimit } = premiumStatus(guild.id);
    const result = db.prepare(`INSERT INTO creator_alerts (guild_id, platform, account, profile, channel_id, message, name, avatar, started)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM creator_alerts WHERE guild_id = ?) < ?`)
      .run(guild.id, platform, account, profile, channelId, message, name, avatar, Date.now(), guild.id, creatorAlertLimit);
    if (!result.changes) throw limitError(creatorAlertLimit);
    return;
  }
  const updated = db.prepare(`UPDATE creator_alerts SET platform = ?, account = ?, profile = ?, channel_id = ?, message = ?, name = ?, avatar = ?, started = ?, error = ''
    WHERE guild_id = ? AND id = ? AND started = ?`).run(
    platform, account, profile, channelId, message, name, avatar,
    sourceChanged ? Date.now() : previous.started, guild.id, previous.id, previous.started
  );
  if (!updated.changes) throw new Error("This alert changed. Reopen Creator Alerts and try again.");
  if (sourceChanged) db.prepare("DELETE FROM creator_alert_sent WHERE alert_id = ?").run(previous.id);
}

async function removeWebhook(client: Client, id: string) {
  try {
    const webhook = await client.fetchWebhook(id);
    await webhook.delete("Temporary creator alert webhook");
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== 10015) throw error;
  }
  db.prepare("DELETE FROM creator_alert_webhooks WHERE id = ?").run(id);
}

function creatorAlertEmbed(alert: Alert, post: Post) {
  const platform = labels[alert.platform];
  const custom = db.prepare("SELECT color FROM creator_alert_platform_colors WHERE guild_id = ? AND platform = ?")
    .get(alert.guild_id, alert.platform) as { color: string } | undefined;
  const color = Number.parseInt((custom?.color || creatorPlatformColorDefaults[alert.platform]).slice(1), 16);
  const template = alert.message.replace(/\r\n/g, "\n");
  const defaultHeading = template === "{account} posted on {platform}!\n{title}\n{url}"
    ? `${alert.account} posted on ${platform}`
    : template === "{account} is live on {platform}!\n{title}\n{url}"
      ? `${alert.account} is live on ${platform}`
      : undefined;
  const values: Record<string, string> = {
    account: alert.account, platform, title: post.title.trim().slice(0, 500), url: post.url
  };
  const body = defaultHeading ? post.title : template.replace(/\{(account|platform|title|url)\}/g, (_, key: string) => values[key]);
  const description = body.trim().slice(0, 4096).trimEnd();
  const previewUrl = post.previewUrl;
  return {
    title: defaultHeading ?? (alert.platform === "twitch" ? "Twitch stream" : `${platform} post`),
    url: post.url,
    color,
    footer: { text: `Message by <@${config.clientId}>` },
    ...(description ? { description } : {}),
    ...(previewUrl && /^https?:\/\//i.test(previewUrl) ? { image: { url: previewUrl } } : {})
  };
}

export async function previewCreatorAlert(guildId: string, id: number, local: boolean) {
  const alert = db.prepare("SELECT * FROM creator_alerts WHERE guild_id = ? AND id = ?").get(guildId, id) as Alert | undefined;
  if (!alert) return null;

  let latest: Post | undefined;
  let notice = "";
  if (!local && creatorAlertAvailable(guildId, id)) {
    try {
      latest = (await posts(alert.platform, alert.account)).sort((a, b) => b.time - a.time)[0];
    } catch {
      notice = "The latest post couldn't be loaded. Showing sample content.";
    }
  }
  if (!latest) {
    const profile = alert.platform === "youtube" && /^UC[\w-]{22}$/.test(alert.account)
      ? "channel/" + alert.account
      : (alert.platform === "youtube" || alert.platform === "tiktok" ? "@" : "") + alert.account;
    latest = {
      id: "", title: alert.platform === "twitch" ? "Example stream title" : "Example post text",
      url: `https://www.${alert.platform === "twitch" ? "twitch.tv" : alert.platform + ".com"}/${profile}`, time: 0
    };
    notice ||= "Showing sample content.";
  }
  return {
    message: creatorAlertEmbed(alert, latest),
    name: alert.name || "Creator Alerts",
    avatar: effectiveCreatorAvatar(alert),
    notice
  };
}

async function sendAlert(guild: Guild, alert: Alert, post: Post) {
  const channel = await destination(guild, alert.channel_id);
  const current = db.prepare("SELECT * FROM creator_alerts WHERE id = ?").get(alert.id) as Alert | undefined;
  if (!current || current.started !== alert.started || current.channel_id !== alert.channel_id || !creatorAlertAvailable(guild.id, alert.id)) return;
  const avatar = effectiveCreatorAvatar(current);
  const uploadedAvatar = avatar.startsWith(uploadedAvatarPrefix);
  const webhook = await channel.createWebhook({
    name: "Crazyland Creator Alerts", reason: "Temporary creator alert webhook",
    ...(uploadedAvatar ? { avatar } : {})
  });
  try {
    db.prepare("INSERT INTO creator_alert_webhooks VALUES (?)").run(webhook.id);
    if (!creatorAlertAvailable(guild.id, alert.id)) return;
    await webhook.send({
      flags: MessageFlags.IsComponentsV2,
      withComponents: true,
      components: [composeV2Container(creatorAlertEmbed(current, post), true)],
      username: current.name || "Creator Alerts", avatarURL: uploadedAvatar ? undefined : avatar || undefined,
      allowedMentions: { users: [config.clientId] }
    });
    db.prepare(`INSERT OR IGNORE INTO creator_alert_sent (alert_id, post_id)
      SELECT id, ? FROM creator_alerts WHERE id = ? AND started = ?`).run(post.id, alert.id, alert.started);
  } finally {
    try {
      await webhook.delete("Temporary creator alert webhook");
      db.prepare("DELETE FROM creator_alert_webhooks WHERE id = ?").run(webhook.id);
    } catch {
      console.error("Could not delete creator alert webhook", webhook.id);
    }
  }
}

export function startCreatorAlerts(client: Client) {
  const poll = async () => {
    try {
      for (const webhook of db.prepare("SELECT id FROM creator_alert_webhooks").all()) {
        await removeWebhook(client, String(webhook.id)).catch(() => console.error("Could not delete creator alert webhook", webhook.id));
      }
      const sources = new Map<string, Promise<Post[]>>();
      for (const alert of db.prepare("SELECT * FROM creator_alerts ORDER BY id").all() as Alert[]) {
        const guild = client.guilds.cache.get(alert.guild_id);
        if (!guild?.available || !creatorAlertAvailable(alert.guild_id, alert.id)) continue;
        try {
          const key = alert.platform + ":" + alert.account;
          let lookup = sources.get(key);
          if (!lookup) {
            lookup = posts(alert.platform, alert.account);
            sources.set(key, lookup);
          }
          const recent = await lookup;
          const sent = db.prepare("SELECT 1 FROM creator_alert_sent WHERE alert_id = ? AND post_id = ?");
          for (const post of recent.filter(post => post.time > alert.started).sort((a, b) => a.time - b.time)) {
            if (!sent.get(alert.id, post.id)) await sendAlert(guild, alert, post);
          }
          if (alert.error) db.prepare("UPDATE creator_alerts SET error = '' WHERE id = ? AND started = ?").run(alert.id, alert.started);
        } catch (error) {
          const message = error instanceof Error && !("code" in error) && !("requestBody" in error)
            ? error.message : "Could not send the alert. Check the destination and webhook settings.";
          db.prepare("UPDATE creator_alerts SET error = ? WHERE id = ? AND started = ?").run(message, alert.id, alert.started);
          if (message !== alert.error) console.error("Creator alert", alert.id, message);
        }
      }
    } catch {
      console.error("Creator alert polling failed.");
    } finally {
      setTimeout(poll, 120_000).unref();
    }
  };
  void poll();
}
