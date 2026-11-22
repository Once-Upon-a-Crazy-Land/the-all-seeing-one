import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { EntitlementType, REST, SKUFlags, type APIEntitlement, type APISKU } from "discord.js";

const discordSkuId = config.discordPremiumSkuId ?? "";
const discordStoreUrl = /^\d{17,20}$/.test(discordSkuId)
  ? `https://discord.com/application-directory/${config.clientId}/store/${discordSkuId}`
  : "";
let discordSkuPublished = false;

db.exec(`
  CREATE TABLE IF NOT EXISTS discord_premium_subscribers (
    sku_id TEXT NOT NULL, user_id TEXT NOT NULL, valid_until INTEGER NOT NULL,
    PRIMARY KEY (sku_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS discord_premium_assignments (
    sku_id TEXT NOT NULL, user_id TEXT NOT NULL, guild_id TEXT NOT NULL,
    PRIMARY KEY (sku_id, user_id), UNIQUE (sku_id, guild_id)
  );
`);

function startDiscordPremiumSync() {
  if (!discordStoreUrl) return;
  const rest = new REST({ version: "10" }).setToken(config.token);
  const insert = db.prepare("INSERT INTO discord_premium_subscribers (sku_id, user_id, valid_until) VALUES (?, ?, ?)");
  const clear = db.prepare("DELETE FROM discord_premium_subscribers WHERE sku_id = ?");

  async function sync() {
    try {
      const skus = await rest.get(`/applications/${config.clientId}/skus`) as APISKU[];
      const sku = skus.find(item => item.id === discordSkuId);
      if (!sku || !(sku.flags & SKUFlags.UserSubscription)) {
        discordSkuPublished = false;
        throw new Error("DISCORD_PREMIUM_SKU_ID must be a User Subscription SKU for this application.");
      }
      discordSkuPublished = Boolean(sku.flags & SKUFlags.Available);
      const subscribers = new Map<string, number>();
      const query = new URLSearchParams({ sku_ids: discordSkuId, exclude_ended: "true", limit: "100" });
      const now = Date.now();
      while (true) {
        const page = await rest.get(`/applications/${config.clientId}/entitlements`, { query }) as APIEntitlement[];
        for (const item of page) {
          if (!item.user_id || item.guild_id || item.deleted || item.sku_id !== discordSkuId || item.application_id !== config.clientId) continue;
          if (item.type !== EntitlementType.ApplicationSubscription && item.type !== EntitlementType.TestModePurchase) continue;
          const starts = item.starts_at == null ? 0 : Date.parse(item.starts_at);
          const ends = item.ends_at == null ? Number.MAX_SAFE_INTEGER : Date.parse(item.ends_at);
          if (starts <= now && ends > now) {
            subscribers.set(item.user_id, Math.max(subscribers.get(item.user_id) ?? 0, ends));
          }
        }
        if (page.length < 100) break;
        const after = page.reduce((max, item) => BigInt(item.id) > BigInt(max) ? item.id : max, "0");
        if (BigInt(after) <= BigInt(query.get("after") ?? "0")) throw new Error("Discord pagination did not advance");
        query.set("after", after);
      }
      db.exec("BEGIN");
      try {
        clear.run(discordSkuId);
        for (const [userId, ends] of subscribers) insert.run(discordSkuId, userId, ends);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      console.error("Discord Premium subscription sync failed", error instanceof Error ? error.message : "");
    } finally {
      setTimeout(() => void sync(), 60_000).unref();
    }
  }
  void sync();
}

db.exec(`CREATE TABLE IF NOT EXISTS premium_subscriptions (
  subscription_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'APPROVAL_PENDING',
  approval_url TEXT NOT NULL, valid_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
); CREATE INDEX IF NOT EXISTS premium_subscriptions_guild ON premium_subscriptions(guild_id,status);`);

export function systemAvailable(guildId: string, kind: 'leveling' | 'economy', systemId: number) {
  const table=kind==='leveling'?'leveling_systems':'economy_systems';
  const rows=db.prepare('SELECT id FROM '+table+' WHERE guild_id=?'+(kind==='economy'?' AND deleted=0':'')+' ORDER BY id LIMIT ?').all(guildId,premiumStatus(guildId).systemLimit) as Array<{id:number}>;
  return rows.some(row=>row.id===systemId);
}
export function checkoutAvailable() {
  const p=config.paypal;
  return !!(p.clientId && p.clientSecret && p.webhookId && /^(sandbox|live)$/.test(p.environment) && /^P-[A-Z0-9]+$/.test(p.planId));
}

function approvalOrigin() {
  return config.paypal.environment === "live" ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";
}

function approvalUrlPattern() {
  return approvalOrigin() + "/%";
}

export function premiumStatus(guildId: string) {
  const now = Date.now();
  const paypalActive = !!db.prepare("SELECT 1 FROM premium_subscriptions WHERE guild_id=? AND approval_url LIKE ? AND status='ACTIVE' AND valid_until>? LIMIT 1").get(guildId, approvalUrlPattern(), now);
  const discordActive = !!discordStoreUrl && !!db.prepare(`
    SELECT 1 FROM discord_premium_assignments a
    JOIN discord_premium_subscribers s USING (sku_id, user_id)
    WHERE a.guild_id = ? AND a.sku_id = ? AND s.valid_until > ?
  `).get(guildId, discordSkuId, now);
  const active = paypalActive || discordActive;
  return {
    active, paypalActive, discordActive, discordStoreUrl: discordSkuPublished ? discordStoreUrl : "",
    checkoutAvailable: checkoutAvailable(),
    systemLimit: active ? 10 : 2, shopItemLimit: active ? 100 : 20,
    shopBuilderLimit: active ? 4 : 2, creatorAlertLimit: active ? 30 : 5
  };
}

const legacyShopLimitReason = "This server can list up to 20 shop items. Unlist another item to list this one.";

export function shopPremiumPauses(guildId: string, plan = premiumStatus(guildId)) {
  const pauses = new Map<number, string>();
  if (plan.active) {
    // Recover listings paused by older versions without changing manually unlisted items.
    db.prepare(`
      UPDATE economy_shop_items SET listed = 1, deactivation_reason = NULL
      WHERE id IN (
        SELECT id FROM economy_shop_items WHERE guild_id = ? AND listed = 0 AND deactivation_reason = ?
        ORDER BY id LIMIT MAX(0, ? - (SELECT COUNT(*) FROM economy_shop_items WHERE guild_id = ? AND listed = 1))
      )
    `).run(guildId, legacyShopLimitReason, plan.shopItemLimit, guildId);
    return pauses;
  }
  const overflow = db.prepare(`
    SELECT id FROM economy_shop_items WHERE guild_id = ? AND listed = 1 ORDER BY id LIMIT -1 OFFSET ?
  `).all(guildId, plan.shopItemLimit);
  const previouslyPaused = db.prepare(`
    SELECT id FROM economy_shop_items WHERE guild_id = ? AND listed = 0 AND deactivation_reason = ?
  `).all(guildId, legacyShopLimitReason);
  for (const { id } of [...overflow, ...previouslyPaused]) {
    pauses.set(Number(id), "Paused by the free plan's shop listing limit.");
  }
  const premiumCurrencies = db.prepare(`
    SELECT DISTINCT p.item_id AS id FROM economy_shop_prices p
    JOIN economy_shop_items i ON i.id = p.item_id
    WHERE i.guild_id = ? AND p.system_id IN (
      SELECT id FROM economy_systems WHERE guild_id = ? AND deleted = 0 ORDER BY id LIMIT -1 OFFSET ?
    )
  `).all(guildId, guildId, plan.systemLimit);
  for (const { id } of premiumCurrencies) pauses.set(Number(id), "Paused because a connected economy system needs Premium.");
  const advancedItems = db.prepare(`
    SELECT id FROM economy_shop_items WHERE guild_id = ?
    AND (json_array_length(requirements_json) > ? OR json_array_length(actions_json) > ?)
  `).all(guildId, plan.shopBuilderLimit, plan.shopBuilderLimit);
  for (const { id } of advancedItems) pauses.set(Number(id), "Paused because this item uses Premium requirements or actions.");
  return pauses;
}

export function discordPremiumAssignment(userId: string) {
  if (!discordStoreUrl) return null;
  const row = db.prepare(`
    SELECT a.guild_id AS guildId
    FROM discord_premium_subscribers s
    LEFT JOIN discord_premium_assignments a USING (sku_id, user_id)
    WHERE s.sku_id = ? AND s.user_id = ? AND s.valid_until > ?
  `).get(discordSkuId, userId, Date.now()) as { guildId: string | null } | undefined;
  return row ? { guildId: row.guildId } : null;
}

export class PremiumAssignmentError extends Error {}

export function setDiscordPremiumAssignment(userId: string, guildId: string, previousGuildId: string | null, assigned: boolean) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = discordPremiumAssignment(userId);
    if (!current) throw new PremiumAssignmentError("No active Discord subscription was found for your account.");
    if (current.guildId !== previousGuildId) throw new PremiumAssignmentError("Your subscription assignment changed. Refresh and try again.");
    if (assigned && current.guildId !== guildId) {
      if (premiumStatus(guildId).active) throw new PremiumAssignmentError("This server already has Premium.");
      // The only assignment we can replace here belongs to an expired subscriber.
      db.prepare("DELETE FROM discord_premium_assignments WHERE sku_id = ? AND guild_id = ?").run(discordSkuId, guildId);
      db.prepare(`
        INSERT INTO discord_premium_assignments (sku_id, user_id, guild_id) VALUES (?, ?, ?)
        ON CONFLICT (sku_id, user_id) DO UPDATE SET guild_id = excluded.guild_id
      `).run(discordSkuId, userId, guildId);
    } else if (!assigned) {
      if (current.guildId !== guildId) throw new PremiumAssignmentError("Your subscription is not assigned to this server.");
      db.prepare("DELETE FROM discord_premium_assignments WHERE sku_id = ? AND user_id = ?").run(discordSkuId, userId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

class PayPalHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly debugId?: string) {
    super(message);
  }

  static async fromResponse(message: string, response: Response) {
    const body = await response.json().catch(() => null) as { name?: unknown; error?: unknown; debug_id?: unknown } | null;
    const code = body?.name ?? body?.error;
    const debugId = body?.debug_id ?? response.headers.get("PayPal-Debug-Id");
    return new PayPalHttpError(message, response.status,
      typeof code === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(code) ? code : undefined,
      typeof debugId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(debugId) ? debugId : undefined);
  }
}

class PayPalSubscriptionMismatch extends Error {}

async function paypal(path: string, method = "GET", body?: unknown, requestId?: string): Promise<any> {
  const p = config.paypal;
  if (!checkoutAvailable()) throw new Error("PayPal checkout is not configured");
  const base = p.environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const tokenResponse = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", signal: AbortSignal.timeout(15000)
  });
  if (!tokenResponse.ok) throw await PayPalHttpError.fromResponse("PayPal authentication failed", tokenResponse);
  const token = await tokenResponse.json() as { access_token: string };
  const response = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw await PayPalHttpError.fromResponse("PayPal request failed", response);
  return response.json();
}


const locks = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous=locks.get(key) || Promise.resolve();
  const current=previous.catch(()=>{}).then(task);
  locks.set(key,current);
  try { return await current; } finally { if(locks.get(key)===current)locks.delete(key); }
}
export async function createPremiumSubscription(guildId: string, userId: string, origin: string) {
  return serialized(guildId,async()=>{
    if(premiumStatus(guildId).active)throw new Error("This server already has premium");
    const existing=db.prepare("SELECT * FROM premium_subscriptions WHERE guild_id=? AND approval_url LIKE ? AND status IN ('ACTIVE','APPROVAL_PENDING','APPROVED','SUSPENDED') ORDER BY created_at DESC LIMIT 1").get(guildId,approvalUrlPattern()) as any;
    if(existing){
      await syncSubscription(existing.subscription_id);
      const updated=db.prepare("SELECT status FROM premium_subscriptions WHERE subscription_id=?").get(existing.subscription_id) as any;
      if(updated.status==='APPROVAL_PENDING' && existing.user_id===userId)return {subscriptionId:existing.subscription_id,approvalUrl:existing.approval_url};
      if(!['CANCELLED','EXPIRED'].includes(updated.status))throw new Error("A subscription already exists for this server");
    }
    const result=await paypal("/v1/billing/subscriptions","POST",{
      plan_id:config.paypal.planId,custom_id:guildId,
      application_context:{shipping_preference:"NO_SHIPPING",user_action:"SUBSCRIBE_NOW",return_url:origin+`/manage/${guildId}/modules/premium?premium=return`,cancel_url:origin+`/manage/${guildId}/modules/premium?premium=cancel`}
    },crypto.randomUUID());
    const approval=new URL(result.links?.find((link:any)=>link.rel==='approve')?.href);
    if(!/^I-[A-Z0-9]+$/.test(result.id)||approval.origin!==approvalOrigin()||approval.username||approval.password)throw new Error("Invalid PayPal response");
    const approvalUrl=approval.href;
    db.prepare("INSERT INTO premium_subscriptions(subscription_id,guild_id,user_id,plan_id,approval_url) VALUES(?,?,?,?,?)").run(result.id,guildId,userId,config.paypal.planId,approvalUrl);
    return {subscriptionId:result.id,approvalUrl};
  });
}
export async function syncSubscription(subscriptionId: string) {
  const stored=db.prepare("SELECT * FROM premium_subscriptions WHERE subscription_id=? AND approval_url LIKE ?").get(subscriptionId,approvalUrlPattern()) as any;
  if(!stored)return;
  const result=await paypal("/v1/billing/subscriptions/"+encodeURIComponent(subscriptionId));
  if(result.id!==subscriptionId||result.plan_id!==stored.plan_id||result.custom_id!==stored.guild_id)throw new PayPalSubscriptionMismatch("Subscription mismatch");
  const nextBilling=Date.parse(result.billing_info?.next_billing_time || "");
  // Access expires at the verified billing boundary unless renewal is confirmed.
  const validUntil=result.status==='ACTIVE' && Number.isFinite(nextBilling)?nextBilling:0;
  db.prepare("UPDATE premium_subscriptions SET status=?,valid_until=? WHERE subscription_id=?").run(result.status,validUntil,subscriptionId);
}
export async function activatePremiumSubscription(subscriptionId: string,guildId: string,userId: string) {
  if(!subscriptionId){
    const pending=db.prepare("SELECT subscription_id FROM premium_subscriptions WHERE guild_id=? AND user_id=? AND approval_url LIKE ? ORDER BY created_at DESC LIMIT 1").get(guildId,userId,approvalUrlPattern()) as any;
    subscriptionId=pending?.subscription_id || "";
  }
  const stored=db.prepare("SELECT 1 FROM premium_subscriptions WHERE subscription_id=? AND guild_id=? AND user_id=? AND approval_url LIKE ?").get(subscriptionId,guildId,userId,approvalUrlPattern());
  if(!stored||!/^I-[A-Z0-9]+$/.test(subscriptionId))throw new Error("Subscription not found");
  await serialized(guildId,()=>syncSubscription(subscriptionId));
  const status=premiumStatus(guildId);
  if(!status.paypalActive)throw new Error("Subscription is not active");
  return status;
}
export async function handlePayPalWebhook(headers: Record<string,unknown>,event: any) {
  const verification=await paypal("/v1/notifications/verify-webhook-signature","POST",{
    auth_algo:headers["paypal-auth-algo"],cert_url:headers["paypal-cert-url"],transmission_id:headers["paypal-transmission-id"],transmission_sig:headers["paypal-transmission-sig"],transmission_time:headers["paypal-transmission-time"],webhook_id:config.paypal.webhookId,webhook_event:event
  });
  if(verification.verification_status!=="SUCCESS")throw new Error("Invalid webhook");
  const subscriptionId=event.event_type?.startsWith("BILLING.SUBSCRIPTION.")?event.resource?.id:event.resource?.billing_agreement_id;
  if(subscriptionId && /^I-[A-Z0-9]+$/.test(subscriptionId)){
    const stored=db.prepare("SELECT guild_id FROM premium_subscriptions WHERE subscription_id=?").get(subscriptionId) as any;
    if(stored)await serialized(stored.guild_id,()=>syncSubscription(subscriptionId));
  }
}
export function startPremiumSync() {
  startDiscordPremiumSync();
  let previouslyMissingSubscriptions = new Set<string>();
  let running=false;
  const sync=async()=>{
    if(running||!checkoutAvailable())return;
    running=true;
    try {
      const rows=db.prepare("SELECT subscription_id,guild_id FROM premium_subscriptions WHERE approval_url LIKE ? AND status IN ('ACTIVE','APPROVED','SUSPENDED','APPROVAL_PENDING')").all(approvalUrlPattern()) as Array<{subscription_id:string;guild_id:string}>;
      const missingSubscriptions = new Set<string>();
      for (const row of rows) {
        try {
          await serialized(row.guild_id, () => syncSubscription(row.subscription_id));
        } catch (error) {
          if (error instanceof PayPalHttpError && error.message === "PayPal request failed"
            && error.status === 404 && error.code === "RESOURCE_NOT_FOUND") {
            missingSubscriptions.add(row.subscription_id);
            if (previouslyMissingSubscriptions.has(row.subscription_id)) continue;
          }
          const reason = error instanceof PayPalHttpError
            ? [error.message, `HTTP ${error.status}`, error.code, error.debugId && `debug ID ${error.debugId}`].filter(Boolean).join(", ")
            : error instanceof PayPalSubscriptionMismatch ? error.message
              : error instanceof Error && error.name === "TimeoutError" ? "PayPal request timed out"
                : error instanceof TypeError ? "PayPal connection failed"
                  : "Unexpected reconciliation error";
          console.error(`PayPal subscription reconciliation failed for server ${JSON.stringify(row.guild_id)} (${config.paypal.environment}) - ${reason}`);
        }
      }
      previouslyMissingSubscriptions = missingSubscriptions;
    } finally {running=false;}
  };
  void sync();setInterval(()=>void sync(),5*60*1000).unref();
}
