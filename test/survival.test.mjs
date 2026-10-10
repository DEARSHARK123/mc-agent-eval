import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from '../src/primitives/helpers.js';
import { decide } from '../src/survival/decide.js';
import { createSurvival } from '../src/survival/index.js';
import { loadConfig } from '../src/config.js';
import { startCompanion } from '../src/main.js';
import { removePathRobust } from '../src/fsutil.js';
import { survivalEnvironment, runSurvivalScenario } from '../scripts/e2e-survival.mjs';
const data=createRequire(import.meta.url)('minecraft-data')('1.20.4');
const c={foodUrgent:6,foodComfort:14,fleeHealth:8,tickMs:250};
const mob=(name='zombie',distance=5)=>({name,distance,dx:distance,dz:1,hasLineOfSight:true});
const s=(v={})=>({now:20000,health:20,food:20,oxygen:20,isSleeping:false,onFire:false,inLava:false,inWater:false,yPosition:64,minY:-64,isNight:false,hostiles:[],hurtRecently:false,weapon:'iron',hasFood:true,bedNearby:false,ownerDistance:null,arbiter:{busy:false},lastAction:null,...v});
const kind=v=>decide(s(v),c)?.kind??null;
test('pure deterministic immutable no clock/random',()=>{
 const snap=s({hostiles:[mob()]});const before=structuredClone(snap),config=structuredClone(c);
 assert.deepEqual(decide(snap,c),decide(snap,c));assert.deepEqual(snap,before);assert.deepEqual(c,config);
 assert.doesNotMatch(readFileSync(new URL('../src/survival/decide.js',import.meta.url),'utf8'),/Date\.now|Math\.random|new Date/);
});
test('adjacent priority 2 through 7',()=>{
 for(const [v,k] of [[{inLava:true,food:1,hostiles:[mob('creeper')]},'escape_hazard'],[{hostiles:[mob('creeper'),mob()],food:1},'flee'],[{hostiles:[mob()],food:1},'fight'],[{food:1,isNight:true,bedNearby:true},'eat_urgent'],[{food:10,isNight:true,bedNearby:true},'sleep']])assert.equal(kind(v),k);
 assert.equal(kind({food:1}), 'eat_urgent');
});
test('hazards and reflex exceptions',()=>{
 for(const [v,r] of [[{inLava:true},'lava'],[{onFire:true},'fire'],[{inWater:true,oxygen:6},'drowning'],[{yPosition:-62},'void']]){
  assert.equal(decide(s(v),c).reason,r);assert.equal(kind({...v,arbiter:{busy:true,source:'reflex'}}),['lava','drowning'].includes(r)?'escape_hazard':null);
 }assert.equal(kind({onFire:true,inWater:true}),null);
});
test('flee predicates direction owner cooldown',()=>{
 for(const v of [{hostiles:[mob('creeper',7)]},{health:8,hostiles:[mob()]},{hostiles:[mob(),mob(),mob()]},{health:13,weapon:null,hostiles:[mob('witch')]}])assert.equal(kind(v),'flee');
 assert.equal(kind({hostiles:[mob('creeper',9)]}),null);
 const v={hostiles:[mob('creeper')]};assert.ok(decide(s(v),c).steps[0].params.x<0);
 assert.equal(decide(s({...v,ownerDistance:4,ownerDirection:{dx:-4,dz:0}}),c).steps[0].params.x,-4);
 const lastAction={kind:'flee',reason:'creeper',at:19500,distance:5};assert.equal(kind({...v,lastAction}),null);assert.equal(kind({hostiles:[mob('creeper',4)],lastAction}),'flee');
});
test('fight target weapon combinations cooldown',()=>{
 assert.equal(decide(s({hostiles:[mob('skeleton',7),mob('zombie',5)]}),c).steps[0].params.entityName,'zombie');
 for(const health of [13,14,20]) for(const weapon of [null,'iron']) for(const name of ['zombie','skeleton','spider','witch','creeper']) {
  const expected=name==='creeper'||(!weapon&&health<14&&name==='witch')?'flee':weapon||health>=14?'fight':null;
  assert.equal(kind({health,weapon,hostiles:[mob(name)]}),expected);
 }
 assert.equal(kind({hostiles:[mob()],lastAction:{kind:'fight',target:'zombie',at:19500}}),null);
});
test('eating thresholds busy food sleep cooldown',()=>{
 assert.equal(kind({food:6}),'eat_urgent');for(let food=7;food<=14;food++)assert.equal(kind({food}),'eat_comfort');
 for(const v of [{food:10,arbiter:{busy:true,source:'owner'}},{food:1,hasFood:false},{food:1,isSleeping:true},{food:1,lastAction:{kind:'eat_urgent',at:19000}},{food:10,lastAction:{kind:'eat_comfort',at:19000}}])assert.equal(kind(v),null);
});
test('sleep gates and wake delegation',()=>{
 const v={isNight:true,bedNearby:true};assert.equal(kind(v),'sleep');
 for(const change of [{isNight:false},{bedNearby:false},{hostilesNearBed:[mob('zombie')]},{hostiles:[mob('zombie',6)]},{arbiter:{busy:true}},{health:6},{lastAction:{kind:'sleep',at:15000}},{isSleeping:true,hostiles:[mob()]},{isSleeping:true,hurtRecently:true}])assert.notEqual(kind({...v,...change}),'sleep');
});
test('sleep ignores far hostiles but not bed-adjacent ones, and clears the bed area',()=>{
 const v={isNight:true,bedNearby:true};
 // 12 from her, 10 from the bed (outside the 8h/5v sleep-blocking box): sleep.
 assert.equal(kind({...v,hostiles:[mob('zombie',12)]}),'sleep');
 // A hostile inside the bed's sleep box: no sleep; engaged if within 12 of her.
 assert.equal(kind({...v,hostilesNearBed:1,hostiles:[{...mob('zombie',10),nearBed:true}]}),'fight');
 assert.equal(kind({...v,hostilesNearBed:1,hostiles:[{...mob('zombie',13),nearBed:true}]}),null);
 // Post-fight sleep cooldown is 3 s: 2 s after a fight she waits, at 3 s she sleeps.
 assert.equal(kind({...v,lastAction:{kind:'fight',at:18000}}),null);
 assert.equal(kind({...v,lastAction:{kind:'fight',at:17000}}),'sleep');
});
test('place_bed relaxes far hostiles, walks into her own hut, owner zones stay protected',()=>{
 const spot={x:0,y:64,z:-1,direction:{dx:0,dz:-1}};
 const v={isNight:true,bedItem:'white_bed',bedSpot:spot};
 assert.equal(kind({...v,hostiles:[mob('zombie',12)]}),'place_bed','a hostile 12 away no longer blocks');
 assert.equal(kind({...v,hostiles:[mob('zombie',6)]}),'fight','a hostile on her is fought first');
 assert.equal(kind({...v,hostilesNearSpot:1}),null,'a hostile next to the spot still blocks');
 const hut=decide(s({...v,hut:{x:8,y:64,z:0}}),c);
 assert.deepEqual(hut.steps[0],{primitive:'goTo',params:{x:8,y:64,z:0,range:1}});
 assert.equal(hut.steps.length,3);
});
test('snapshot picks a bedSpot inside an own_build hut and still rejects owner zones',()=>{
 const inventory={items:()=>[{name:'white_bed'}]};
 const night={time:{isDay:false},inventory};
 const own={zones:()=>[{x:8,y:64,z:0,radius:6,reason:'own_build'}]};
 const f=fixture(night,null,{protection:own});f.advance();
 assert.equal(f.tasks[0].label,'survival:place_bed');
 assert.deepEqual(f.tasks[0].steps[0],{primitive:'goTo',params:{x:8,y:64,z:0,range:1}});
 const spot=f.tasks[0].steps[2].params;
 assert.ok((spot.x-8)**2+(spot.y-64)**2+spot.z**2<=36,'bed spot is inside the own_build zone');
 f.survival.stop();
 const owner={zones:()=>[{x:8,y:64,z:0,radius:6,reason:'owner'},{x:0,y:64,z:0,radius:6,reason:'owner'}]};
 const g=fixture(night,null,{protection:owner});g.advance();
 assert.equal(g.tasks.length,0,'an owner zone still vetoes every spot');g.survival.stop();
});
function fixture(overrides={},current=null,options={}) {
 const calls=[],events=[],tasks=[],timers=new Map();let time=20000,resolveDone;
 const bot=Object.assign(new EventEmitter(),{entity:{position:new Vec3(0,64,0),metadata:[]},health:20,food:20,oxygenLevel:20,time:{isDay:true},entities:{},players:{},inventory:{items:()=>[]},findBlock:()=>null,blockAt:p=>p.y<64?{name:'stone',boundingBox:'block'}:{name:'air',boundingBox:'empty'},setControlState:(...a)=>calls.push(a),attack:()=>calls.push('attack'),dig:()=>calls.push('dig'),consume:()=>calls.push('consume'),chat:()=>calls.push('chat')},overrides);
 const clock={now:()=>time,setInterval:(fn,ms)=>{assert.equal(ms,250);timers.set(1,fn);return 1;},clearInterval:id=>timers.delete(id)};
 const survival=createSurvival({bot,registry:{validate(){}},arbiter:{current:()=>current,submit:t=>{tasks.push(t);return {accepted:true,done:new Promise(r=>resolveDone=r)};}},eventlog:{append:(kind,payload)=>events.push({kind,payload})},mcData:data,config:c,clock,protection:options.protection});
 return {bot,survival,calls,events,tasks,timers,advance:()=>{time+=4000;timers.get(1)?.();},finish:()=>resolveDone?.()};
}
test('adapter cadence health safe escape drowning cleanup',async()=>{
 const f=fixture({food:5,inventory:{items:()=>[{type:data.itemsByName.bread.id,name:'bread'}]}});assert.equal(f.tasks.length,0);f.advance();assert.equal(f.tasks[0].source,'reflex');assert.equal(f.tasks[0].label,'survival:eat_urgent');f.bot.health=19;f.bot.emit('health');assert.equal(f.tasks.length,1);f.advance();assert.equal(f.tasks.length,2);f.survival.stop();f.survival.stop();assert.equal(f.timers.size,0);assert.equal(f.bot.listenerCount('health'),0);f.bot.health=18;f.bot.emit('health');assert.equal(f.tasks.length,2);
 const g=fixture({oxygenLevel:6,blockAt:p=>p.x===0&&p.z===0&&p.y===64?{name:'water',boundingBox:'empty'}:p.y<64?{name:'stone',boundingBox:'block'}:{name:'air',boundingBox:'empty'}});g.advance();const q=g.tasks[0].steps[0].params;assert.equal(g.bot.blockAt(new Vec3(q.x,q.y-1,q.z)).boundingBox,'block');assert.equal(g.bot.blockAt(new Vec3(q.x,q.y,q.z)).name,'air');assert.equal(g.bot.blockAt(new Vec3(q.x,q.y+1,q.z)).name,'air');assert.deepEqual(g.calls[0],['jump',true]);g.finish();await new Promise(r=>setImmediate(r));assert.deepEqual(g.calls.at(-1),['jump',false]);g.survival.stop();
 for(const [v,source] of [[{food:10,inventory:{items:()=>[{type:data.itemsByName.bread.id,name:'bread'}]}},'idle'],[{time:{isDay:false},findBlock:()=>({name:'red_bed'})},'plan']]){const h=fixture(v);h.advance();assert.equal(h.tasks[0].source,source);h.survival.stop();}
});
test('config nonenumerable defaults invalid values SURVIVAL=0 wiring',()=>{
 const env={OWNER_UUID:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'};const conf=loadConfig(env);assert.equal(conf.survival,true);assert.equal(conf.survivalTickMs,250);assert.equal(conf.foodUrgent,6);assert.equal(conf.foodComfort,14);assert.equal(conf.fleeHealth,8);assert.equal(Object.keys(conf).includes('survival'),false);assert.equal(loadConfig({...env,SURVIVAL:'0'}).survival,false);
 for(const name of ['SURVIVAL','SURVIVAL_TICK_MS','SURVIVAL_FOOD_URGENT','SURVIVAL_FOOD_COMFORT','SURVIVAL_FLEE_HEALTH'])assert.throws(()=>loadConfig({...env,[name]:'secret-invalid'}),e=>e.message.includes(name)&&!e.message.includes('secret-invalid'));
 const main=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');assert.match(main,/if \(config.survival\)/);assert.match(main,/get survival\(\)/);assert.match(main,/resources.survival\?\.stop\(\)/);
});
test('action interrupted events exclude chat',()=>{
 const f=fixture({food:1,inventory:{items:()=>[{type:data.itemsByName.bread.id,name:'bread'}]}},{source:'owner',label:'owner-task'});f.advance();assert.deepEqual(f.events.map(e=>e.kind),['survival.interrupted','survival.action']);assert.deepEqual(f.events[0].payload,{source:'owner',label:'owner-task'});assert.equal('text' in f.events[1].payload,false);f.survival.stop();
});
test('whitelist no direct privileged bot calls',()=>{
 for(const v of [{hostiles:[mob()]},{hostiles:[mob('creeper')]},{food:1},{food:10},{isNight:true,bedNearby:true}])for(const step of decide(s(v),c).steps)assert.ok(['eat','attack','sleep','goTo'].includes(step.primitive));
 const f=fixture({food:1,inventory:{items:()=>[{type:data.itemsByName.bread.id,name:'bread'}]}});f.advance();assert.deepEqual(f.calls,[]);f.survival.stop();
});
test('health drop immediate danger and oxygen recovery',()=>{
 const f=fixture();f.bot.health=19;f.bot.blockAt=p=>p.y===64?{name:'lava'}:p.y<64?{name:'stone',boundingBox:'block'}:{name:'air'};f.bot.emit('health');assert.equal(f.tasks[0].label,'survival:escape_hazard');f.survival.stop();
 const g=fixture({oxygenLevel:6,blockAt:p=>p.y===64?{name:'water'}:p.y<64?{name:'stone',boundingBox:'block'}:{name:'air'}});g.advance();assert.deepEqual(g.calls.at(-1),['jump',true]);g.bot.oxygenLevel=15;g.advance();assert.deepEqual(g.calls.at(-1),['jump',false]);g.survival.stop();
});
test('hostile filtering and shared safe food selection',()=>{
 for(const name of ['player','villager','iron_golem','wolf','enderman','cow']) {const f=fixture({entities:{e:{name,position:new Vec3(2,64,0)} }});f.advance();assert.equal(f.tasks.length,0);f.survival.stop();}
 for(const [food,name,expected] of [[10,'rotten_flesh',0],[6,'rotten_flesh',1],[6,'pufferfish',0],[10,'bread',1]]) {const f=fixture({food,inventory:{items:()=>[{name,type:data.itemsByName[name].id}]}});f.advance();assert.equal(f.tasks.length,expected);f.survival.stop();}
});
test('main enabled disabled read-only lifecycle with fake bot/fetch',async()=>{
 const root=new URL('../../.tmp/',import.meta.url);mkdirSync(root,{recursive:true});
 for(const enabled of ['0','1']) {
  const dir=mkdtempSync(new URL('t21-main-',root));
  const bot=Object.assign(new EventEmitter(),{entity:{position:new Vec3(0,64,0)},players:{},entities:{},health:20,food:20,inventory:{items:()=>[]},loadPlugin(){},quit(){},blockAt:()=>null,findBlock:()=>null});
  let requests=0;
  const app=startCompanion({config:loadConfig({OWNER_UUID:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',COMPANION_DATA_DIR:dir,SURVIVAL:enabled}),signals:new EventEmitter(),createBot:()=>bot,pathfinderPlugin:()=>{},mcData:data,fetch:async()=>{requests++;throw new Error('offline');},piManagerFactory:()=>({start:async()=>{},close:async()=>{},available:()=>false})});
  try { bot.emit('spawn');await app.ready;assert.equal(!!app.survival,enabled==='1');assert.throws(()=>{app.survival={};},TypeError);assert.equal(bot.listenerCount('health'),enabled==='1'?1:0);assert.equal(requests,0); }
  finally {await app.close();assert.equal(bot.listenerCount('health'),0);removePathRobust(dir);}
 }
});
test('e2e survival gate dispatch and default regression',async()=>{
 const lines=[];assert.equal(survivalEnvironment({},x=>lines.push(x)),false);assert.match(lines[0],/SKIP/);assert.equal(survivalEnvironment({E2E_SURVIVAL:'1'}),true);
 const source=readFileSync(new URL('../scripts/e2e.mjs',import.meta.url),'utf8');assert.match(source,/SURVIVAL: \['survival', 'v1', 'edges', 'stance'\]\.includes\(scenario\) \? '1' : '0'/);assert.match(source,/'spawn-monsters': 'true', 'spawn-animals': 'true'/);assert.match(source,/runSurvivalScenario\(\{/);assert.match(source,/owner.chat\('四个木板就能合成工作台'\)/);assert.match(source,/owner.chat\('跟着我'\)/);
 let time=0,id=0,events=[],commands=[];const bot={health:20,food:20,entities:{},entity:{position:new Vec3(0,64,0)},inventory:{items:()=>[{name:'iron_sword'}]}};
 const action=kind=>events.push({id:++id,payload:{kind}});
 const command=text=>{commands.push(text);if(text.includes('summon zombie'))action('fight');if(text.includes('summon creeper')){bot.entities.c={name:'creeper',position:bot.entity.position.offset(4,0,0)};action('flee');bot.entity.position=bot.entity.position.offset(-6,0,0);}if(text.includes('kill @e'))bot.entities={};if(text.includes('effect give'))bot.food=6;if(text.includes('give Companion bread')){action('eat_urgent');bot.food=20;}if(text.endsWith(' lava')){action('escape_hazard');bot.entity.position=bot.entity.position.offset(3,0,0);}if(text.includes('part=head'))bot.isSleeping=true;};
 await runSurvivalScenario({app:{bot,eventlog:{query:()=>events}},command,delay:async ms=>{time+=ms;},now:()=>time,log:x=>lines.push(x)});
 assert.equal(lines.filter(x=>/ (fight|flee|eat|lava|sleep) PASS/.test(x)).length,5);assert.ok(commands.filter(x=>x.includes('summon')).every(x=>x.startsWith('execute at Companion run summon')));
 await assert.rejects(runSurvivalScenario({app:{bot:{...bot,inventory:{items:()=>[]}},eventlog:{query:()=>[]}},command(){},delay:async ms=>{time+=ms;},now:()=>time,log:x=>lines.push(x)}),/sword: timed out/);assert.match(lines.at(-1),/FAIL/);
});

test('decide place_bed: gate order, lookAt-then-place steps, cooldown',()=>{
 const spot={x:0,y:64,z:-1,direction:{dx:0,dz:-1}};
 const v={isNight:true,bedItem:'white_bed',bedSpot:spot};
 const action=decide(s(v),c);
 assert.equal(action.kind,'place_bed');
 assert.equal(action.reason,'night');
 assert.deepEqual(action.steps,[{primitive:'lookAt',params:{x:0.5,y:64.5,z:-1.5}},{primitive:'place',params:{itemName:'white_bed',x:0,y:64,z:-1}}]);
 for(const change of [{isNight:false},{bedItem:null},{bedSpot:null},{hostiles:[mob()]},{arbiter:{busy:true}},{health:6},{isSleeping:true},{bedNearby:true},{lastAction:{kind:'place_bed',at:15000}}]){
  const got=kind({...v,...change});
  assert.notEqual(got,'place_bed',JSON.stringify(change));
 }
 assert.equal(kind({...v,bedNearby:true}),'sleep','an existing bed still goes straight to sleep');
});
test('snapshot: bedItem, four-direction bedSpot, plant cells, protection veto',()=>{
 const inventory={items:()=>[{name:'white_bed'}]};
 const night={time:{isDay:false},inventory};
 const f=fixture(night);f.advance();
 assert.equal(f.tasks[0].label,'survival:place_bed');assert.equal(f.tasks[0].source,'plan');
 assert.deepEqual(f.tasks[0].steps[1],{primitive:'place',params:{itemName:'white_bed',x:0,y:64,z:-1}});
 f.survival.stop();
 // North is blocked by a boulder, so the next direction (east) is picked.
 const east=fixture({...night,blockAt:p=>{if(p.x===0&&p.z===-1&&p.y===64)return {name:'stone',boundingBox:'block'};if(p.x===0&&p.z===-2&&p.y===64)return {name:'dandelion',boundingBox:'empty'};return p.y<64?{name:'stone',boundingBox:'block'}:{name:'air',boundingBox:'empty'};}});
 east.advance();assert.deepEqual(east.tasks[0].steps[1].params,{itemName:'white_bed',x:1,y:64,z:0});east.survival.stop();
 // A protection zone covering every foot cell suppresses the whole action.
 const zone=fixture(night,null,{protection:{contains:()=>true}});
 zone.advance();assert.equal(zone.tasks.length,0);zone.survival.stop();
 // No solid floor anywhere: no spot.
 const floating=fixture({...night,blockAt:p=>p.y===64?{name:'air',boundingBox:'empty'}:{name:'air',boundingBox:'empty'}});
 floating.advance();assert.equal(floating.tasks.length,0);floating.survival.stop();
 // A bed nearby skips place_bed entirely.
 const near=fixture({...night,findBlock:()=>({name:'red_bed'})});near.advance();
 assert.equal(near.tasks[0].label,'survival:sleep');near.survival.stop();
});
