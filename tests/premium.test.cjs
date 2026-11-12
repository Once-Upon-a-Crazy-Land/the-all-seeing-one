const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const {DatabaseSync}=require('node:sqlite');
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE leveling_systems(id INTEGER PRIMARY KEY,guild_id TEXT); CREATE TABLE economy_systems(id INTEGER PRIMARY KEY,guild_id TEXT,deleted INTEGER DEFAULT 0); INSERT INTO leveling_systems VALUES(1,'g'),(2,'g'),(3,'g'); INSERT INTO economy_systems(id,guild_id)VALUES(1,'g'),(2,'g'),(3,'g');");
 const config={paypal:{clientId:'client',clientSecret:'secret',webhookId:'hook',environment:'sandbox',planId:'P-PLAN'}};
 const requests=[];let status='ACTIVE',signature='SUCCESS',custom='g',plan='P-PLAN';
 const context={exports:{},require:name=>name==='node:crypto'?require('node:crypto'):name==='./config.js'?{config}:{db},Buffer,URL,Date,AbortSignal,console,setInterval:()=>({unref(){}}),fetch:async(url,options)=>{
  requests.push({url,options});
  const approvalHost=config.paypal.environment==='live'?'www.paypal.com':'www.sandbox.paypal.com';
  let body=url.endsWith('/token')?{access_token:'token'}:url.endsWith('verify-webhook-signature')?{verification_status:signature}:url.endsWith('/v1/billing/subscriptions')?{id:'I-SUB',links:[{rel:'approve',href:'https://'+approvalHost+'/approve'}]}:{id:'I-SUB',status,plan_id:plan,custom_id:custom,billing_info:{next_billing_time:new Date(Date.now()+86400000).toISOString()}};
  return {ok:true,json:async()=>body};
 }};
 vm.createContext(context);vm.runInContext(ts.transpileModule(fs.readFileSync('src/premium.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,context);
 return {db,api:context.exports,config,requests,setStatus:v=>status=v,setSignature:v=>signature=v,setCustom:v=>custom=v,setPlan:v=>plan=v};
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

test('shop limits preserve items and allow choosing replacement listings after premium expires',async()=>{
 const h=setup();h.db.exec("CREATE TABLE economy_shop_items(id INTEGER PRIMARY KEY,guild_id TEXT,listed INTEGER,deactivation_reason TEXT); INSERT INTO economy_shop_items VALUES(999,'other',1,NULL)");
 const insert=h.db.prepare("INSERT INTO economy_shop_items VALUES(?,'g',1,NULL)");for(let id=1;id<=100;id++)insert.run(id);
 assert.equal(h.api.premiumStatus('g').shopItemLimit,20);
 await h.api.createPremiumSubscription('g','u','https://example.com');await h.api.activatePremiumSubscription('I-SUB','g','u');assert.equal(h.api.enforceShopItemLimit('g'),100);
 assert.equal(h.db.prepare("SELECT COUNT(*) n FROM economy_shop_items WHERE guild_id='g' AND listed=1").get().n,100);
 h.db.prepare('UPDATE premium_subscriptions SET valid_until=0').run();assert.equal(h.api.enforceShopItemLimit('g'),20);
 assert.equal(h.db.prepare("SELECT COUNT(*) n FROM economy_shop_items WHERE guild_id='g'").get().n,100);
 assert.equal(h.db.prepare("SELECT COUNT(*) n FROM economy_shop_items WHERE guild_id='g' AND listed=1").get().n,20);
 assert.equal(h.db.prepare('SELECT listed FROM economy_shop_items WHERE id=999').get().listed,1);
 h.db.exec('UPDATE economy_shop_items SET listed=0 WHERE id=1; UPDATE economy_shop_items SET listed=1,deactivation_reason=NULL WHERE id=100');h.api.enforceShopItemLimit('g');assert.equal(h.db.prepare('SELECT listed FROM economy_shop_items WHERE id=100').get().listed,1);h.db.close();
});
