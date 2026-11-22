const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const {DatabaseSync}=require('node:sqlite');
const {EntitlementType,SKUFlags}=require('discord.js');
function setup(discord = {}, logger = console){
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE leveling_systems(id INTEGER PRIMARY KEY,guild_id TEXT); CREATE TABLE economy_systems(id INTEGER PRIMARY KEY,guild_id TEXT,deleted INTEGER DEFAULT 0); INSERT INTO leveling_systems VALUES(1,'g'),(2,'g'),(3,'g'); INSERT INTO economy_systems(id,guild_id)VALUES(1,'g'),(2,'g'),(3,'g');");
 const config={clientId:'application',discordPremiumSkuId:discord.skuId,paypal:{clientId:'client',clientSecret:'secret',webhookId:'hook',environment:'sandbox',planId:'P-PLAN'}};
 const requests=[];let status='ACTIVE',signature='SUCCESS',custom='g',plan='P-PLAN';
 const discordTimers=[];
 const paypalTimers=[];
 let subscriptionError;
 const REST=class { setToken(){return this} async get(...args){return discord.get(...args)} };
 const context={exports:{},require:name=>name==='node:crypto'?require('node:crypto'):name==='./config.js'?{config}:name==='discord.js'?{REST,EntitlementType,SKUFlags}:{db},Buffer,URL,URLSearchParams,Date,AbortSignal,console:logger,setTimeout:callback=>{discordTimers.push(callback);return {unref(){}}},setInterval:callback=>{paypalTimers.push(callback);return {unref(){}}},fetch:async(url,options)=>{
  requests.push({url,options});
  if (subscriptionError && url.includes('/v1/billing/subscriptions/')) {
   const { status, name, debugId } = subscriptionError;
   return Response.json({ name, debug_id: debugId }, { status });
  }
  const approvalHost=config.paypal.environment==='live'?'www.paypal.com':'www.sandbox.paypal.com';
  let body=url.endsWith('/token')?{access_token:'token'}:url.endsWith('verify-webhook-signature')?{verification_status:signature}:url.endsWith('/v1/billing/subscriptions')?{id:'I-SUB',links:[{rel:'approve',href:'https://'+approvalHost+'/approve'}]}:{id:'I-SUB',status,plan_id:plan,custom_id:custom,billing_info:{next_billing_time:new Date(Date.now()+86400000).toISOString()}};
  return {ok:true,json:async()=>body};
 }};
 vm.createContext(context);vm.runInContext(ts.transpileModule(fs.readFileSync('src/premium.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,context);
 return {db,api:context.exports,config,requests,discordTimers,paypalTimers,setSubscriptionError:v=>subscriptionError=v,setStatus:v=>status=v,setSignature:v=>signature=v,setCustom:v=>custom=v,setPlan:v=>plan=v};
}
test('free limits, verified activation, expiry, and disabled checkout',async()=>{
 const h=setup();assert.equal(h.api.premiumStatus('g').systemLimit,2);assert(h.api.systemAvailable('g','leveling',2));assert(!h.api.systemAvailable('g','leveling',3));assert(!h.api.systemAvailable('g','economy',3));
 const order=await h.api.createPremiumSubscription('g','u','https://example.com');assert.equal(order.subscriptionId,'I-SUB');assert(!h.api.premiumStatus('g').active);
 await assert.rejects(h.api.activatePremiumSubscription('I-SUB','other','u'));
 await assert.rejects(h.api.activatePremiumSubscription('I-SUB','g','other'));
 h.setStatus('APPROVAL_PENDING');await assert.rejects(h.api.activatePremiumSubscription('I-SUB','g','u'));
 h.setStatus('ACTIVE');h.setCustom('other');await assert.rejects(h.api.activatePremiumSubscription('I-SUB','g','u'));assert(!h.api.premiumStatus('g').active);
 h.setCustom('g');h.setPlan('P-WRONG');await assert.rejects(h.api.activatePremiumSubscription('I-SUB','g','u'));
 h.setPlan('P-PLAN');await h.api.activatePremiumSubscription('','g','u');assert.equal(h.api.premiumStatus('g').systemLimit,10);assert(h.api.systemAvailable('g','economy',3));
 await h.api.activatePremiumSubscription('I-SUB','g','u');assert.equal(h.db.prepare('SELECT COUNT(*) n FROM premium_subscriptions').get().n,1);
 h.db.prepare('UPDATE premium_subscriptions SET valid_until=0').run();assert(!h.api.premiumStatus('g').active);
 h.config.paypal.planId='';assert(!h.api.checkoutAvailable());h.db.close();
});
test('verified webhooks reconcile current state and reject forged events',async()=>{
 const h=setup();await h.api.createPremiumSubscription('g','u','https://example.com');await h.api.activatePremiumSubscription('I-SUB','g','u');
 h.setStatus('CANCELLED');h.setSignature('FAILURE');await assert.rejects(h.api.handlePayPalWebhook({}, {event_type:'BILLING.SUBSCRIPTION.CANCELLED',resource:{id:'I-SUB'}}));assert(h.api.premiumStatus('g').active);
 h.setSignature('SUCCESS');await h.api.handlePayPalWebhook({}, {event_type:'BILLING.SUBSCRIPTION.CANCELLED',resource:{id:'I-SUB'}});assert(!h.api.premiumStatus('g').active);
 h.setStatus('ACTIVE');await h.api.handlePayPalWebhook({}, {event_type:'PAYMENT.SALE.COMPLETED',resource:{billing_agreement_id:'I-SUB'}});assert(h.api.premiumStatus('g').active);
 h.setStatus('SUSPENDED');await h.api.handlePayPalWebhook({}, {event_type:'BILLING.SUBSCRIPTION.ACTIVATED',resource:{id:'I-SUB',status:'ACTIVE'}});assert(!h.api.premiumStatus('g').active);h.db.close();
});
test('concurrent checkout requests reuse pending subscription',async()=>{
 const h=setup();h.setStatus('APPROVAL_PENDING');const results=await Promise.all([h.api.createPremiumSubscription('g','u','https://example.com'),h.api.createPremiumSubscription('g','u','https://example.com')]);assert.equal(results[0].subscriptionId,results[1].subscriptionId);assert.equal(h.requests.filter(r=>r.url.endsWith('/v1/billing/subscriptions')).length,1);h.db.close();
});

test('live checkout and reconciliation skip stored sandbox subscriptions', async () => {
 const h = setup();
 h.db.prepare(`INSERT INTO premium_subscriptions
  (subscription_id,guild_id,user_id,plan_id,status,approval_url,valid_until)
  VALUES ('I-OLD','g','u','P-PLAN','ACTIVE','https://www.sandbox.paypal.com/approve',?)`).run(Date.now()+86400000);
 assert.equal(h.api.premiumStatus('g').active, true);

 h.config.paypal.environment = 'live';
 assert.equal(h.api.premiumStatus('g').active, false);
 await assert.rejects(h.api.activatePremiumSubscription('I-OLD','g','u'), /Subscription not found/);
 await h.api.syncSubscription('I-OLD');
 assert.equal(h.requests.length, 0);

 const order = await h.api.createPremiumSubscription('g','u','https://example.com');
 assert.equal(order.approvalUrl, 'https://www.paypal.com/approve');
 assert.equal(h.requests.filter(request => request.url.includes('/I-OLD')).length, 0);
 assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM premium_subscriptions').get().count, 2);
 h.db.close();
});

test('reconciliation logs continuous PayPal 404s once while continuing to verify the subscription', async () => {
 const errors = [];
 const h = setup({}, { error: message => errors.push(message) });
 const flush = () => new Promise(resolve => setImmediate(resolve));
 try {
  h.config.paypal.environment = 'live';
  await h.api.createPremiumSubscription('g', 'u', 'https://example.com');
  await h.api.activatePremiumSubscription('I-SUB', 'g', 'u');
  const check = h.db.prepare("SELECT status, valid_until FROM premium_subscriptions WHERE subscription_id = 'I-SUB'");
  const verified = check.get();
  h.requests.length = 0;

  h.setSubscriptionError({ status: 404, name: 'RESOURCE_NOT_FOUND', debugId: 'first' });
  h.api.startPremiumSync();
  await flush();
  h.setSubscriptionError({ status: 404, name: 'RESOURCE_NOT_FOUND', debugId: 'second' });
  h.paypalTimers[0]();
  await flush();
  assert.equal(h.requests.filter(request => request.url.endsWith('/I-SUB')).length, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /server "g" \(live\).*HTTP 404, RESOURCE_NOT_FOUND, debug ID first/);
  assert.deepEqual(check.get(), verified);

  h.setSubscriptionError(null);
  h.paypalTimers[0]();
  await flush();
  h.setSubscriptionError({ status: 404, name: 'RESOURCE_NOT_FOUND', debugId: 'after-recovery' });
  h.paypalTimers[0]();
  await flush();
  assert.equal(errors.length, 2);
  assert.match(errors[1], /debug ID after-recovery/);

  h.setSubscriptionError({ status: 503, name: 'SERVICE_UNAVAILABLE', debugId: 'outage' });
  h.paypalTimers[0]();
  await flush();
  h.paypalTimers[0]();
  await flush();
  assert.equal(errors.length, 4);
  assert.match(errors[3], /HTTP 503, SERVICE_UNAVAILABLE/);
 } finally { h.db.close(); }
});

test('Discord subscriptions follow one server, can move or detach, and lose access on revocation', async () => {
 const skuId = '100000000000000001';
 const entitlement = { id: '100000000000000010', sku_id: skuId, application_id: 'application', user_id: 'buyer', deleted: false, type: EntitlementType.ApplicationSubscription };
 let entitlements = [
  entitlement,
  { ...entitlement, id: '100000000000000011', user_id: 'other-buyer' },
  { ...entitlement, id: '100000000000000012', user_id: 'guild-buyer', guild_id: 'g' },
  { ...entitlement, id: '100000000000000013', user_id: 'expired', ends_at: new Date(0).toISOString() }
 ];
 const { api, db, config, discordTimers } = setup({
  skuId,
  get(path, options) {
   if (path.endsWith('/skus')) return [{ id: skuId, flags: SKUFlags.UserSubscription | SKUFlags.Available }];
   assert.equal(path, '/applications/application/entitlements');
   assert.equal(options.query.get('sku_ids'), skuId);
   return entitlements;
  }
 });
 try {
  config.paypal.planId = '';
  api.startPremiumSync();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.discordPremiumAssignment('buyer').guildId, null);
  assert.equal(api.discordPremiumAssignment('guild-buyer'), null);
  assert.equal(api.discordPremiumAssignment('expired'), null);
  assert.throws(() => api.setDiscordPremiumAssignment('no-subscription', 'g', null, true), /No active Discord subscription/);
  api.setDiscordPremiumAssignment('buyer', 'g', null, true);
  assert.equal(api.premiumStatus('g').discordActive, true);
  assert.equal(api.systemAvailable('g', 'leveling', 3), true);
  assert.throws(() => api.setDiscordPremiumAssignment('other-buyer', 'g', null, true), /already has Premium/);

  api.setDiscordPremiumAssignment('buyer', 'second', 'g', true);
  assert.equal(api.premiumStatus('g').active, false);
  assert.equal(api.systemAvailable('g', 'leveling', 3), false);
  assert.equal(api.premiumStatus('second').active, true);
  assert.throws(() => api.setDiscordPremiumAssignment('buyer', 'g', 'g', true), /assignment changed/);
  api.setDiscordPremiumAssignment('buyer', 'second', 'second', false);
  assert.equal(api.premiumStatus('second').active, false);
  api.setDiscordPremiumAssignment('buyer', 'g', null, true);
  assert.equal(api.systemAvailable('g', 'leveling', 3), true);

  entitlements = entitlements.filter(item => item.user_id !== 'buyer');
  discordTimers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.premiumStatus('g').active, false);
  api.setDiscordPremiumAssignment('other-buyer', 'g', null, true);
  assert.equal(api.premiumStatus('g').active, true);
 } finally { db.close(); }
});

test('shop listings and Premium configurations pause without changing saved settings and resume on renewal',async()=>{
 const { api, db } = setup();
 try {
  db.exec(`
   CREATE TABLE economy_shop_items (id INTEGER PRIMARY KEY, guild_id TEXT, listed INTEGER,
    deactivation_reason TEXT, requirements_json TEXT DEFAULT '[]', actions_json TEXT DEFAULT '[]');
   CREATE TABLE economy_shop_prices (item_id INTEGER, system_id INTEGER);
   INSERT INTO economy_shop_items (id,guild_id,listed) VALUES (999,'other',1),(2000,'g',0),(2001,'g',0);
   INSERT INTO economy_shop_prices VALUES (1,3);
   UPDATE economy_shop_items SET deactivation_reason =
    'This server can list up to 20 shop items. Unlist another item to list this one.' WHERE id = 2000;
  `);
  const insert = db.prepare("INSERT INTO economy_shop_items (id,guild_id,listed) VALUES (?,'g',1)");
  for (let id = 1; id <= 21; id++) insert.run(id);
  db.prepare("UPDATE economy_shop_items SET actions_json = '[{},{},{}]' WHERE id = 2").run();

  const paused = api.shopPremiumPauses('g');
  assert.deepEqual([...paused.keys()].sort((a,b)=>a-b), [1, 2, 21, 2000]);
  assert.equal(db.prepare("SELECT listed FROM economy_shop_items WHERE id=21").get().listed, 1);
  assert.equal(db.prepare("SELECT listed FROM economy_shop_items WHERE id=999").get().listed, 1);
  db.prepare("UPDATE economy_shop_items SET listed=0 WHERE id=3").run();
  assert.equal(api.shopPremiumPauses('g').has(21), false);

  await api.createPremiumSubscription('g','u','https://example.com');
  await api.activatePremiumSubscription('I-SUB','g','u');
  assert.equal(api.shopPremiumPauses('g').size, 0);
  assert.equal(db.prepare("SELECT listed FROM economy_shop_items WHERE id=2000").get().listed, 1);
  assert.equal(db.prepare("SELECT listed FROM economy_shop_items WHERE id=2001").get().listed, 0);
  assert.equal(db.prepare("SELECT listed FROM economy_shop_items WHERE id=3").get().listed, 0);
 } finally { db.close(); }
});
