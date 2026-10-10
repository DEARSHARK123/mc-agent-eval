export function survivalEnvironment(env, log=console.log) {
  if(env.E2E_SURVIVAL!=='1') {log('E2E SURVIVAL SKIP: set E2E_SURVIVAL=1');return false;} return true;
}
export async function runSurvivalScenario({app,command,delay,botName='Companion',log=console.log,now=Date.now}) {
  const bot=app.bot;
  const wait=async(label,predicate,ms=10000)=>{const end=now()+ms;while(!predicate()){if(now()>=end)throw new Error(`${label}: timed out health=${bot.health} food=${bot.food}`);await delay(100);}};
  const events=()=>app.eventlog.query({kind:'survival.action'});
  const action=(kind,after)=>events().some(e=>e.id>after&&e.payload.kind===kind);
  const marker=()=>events().at(-1)?.id??0;
  const mobs=name=>Object.values(bot.entities??{}).filter(e=>e.name===name&&e.isValid!==false);
  try {
    command('difficulty normal');command(`gamemode survival ${botName}`);command(`give ${botName} iron_sword 1`);
    await wait('sword',()=>bot.inventory.items().some(i=>i.name==='iron_sword'));
    let before=marker();command(`execute at ${botName} run summon zombie ~4 ~ ~ {NoAI:1b}`);
    await wait('fight',()=>action('fight',before));await wait('zombie killed',()=>!mobs('zombie').length,30000);
    if(bot.health<=10)throw new Error('fight health <= 10');log('E2E SURVIVAL fight PASS');
    before=marker();command(`execute at ${botName} run summon creeper ~4 ~ ~ {NoAI:1b,Silent:1b}`);
    await wait('creeper visible',()=>mobs('creeper').length);const creeper=mobs('creeper')[0];
    await wait('flee',()=>action('flee',before)&&bot.entity.position.distanceTo(creeper.position)>8);log('E2E SURVIVAL flee PASS');
    command(`execute at ${botName} run kill @e[type=minecraft:creeper]`);
    // Withhold food until the urgent threshold, avoiding comfort eating during hunger setup.
    command(`clear ${botName} bread`);command(`effect give ${botName} minecraft:hunger 30 255 true`);
    await wait('urgent hunger',()=>bot.food<=6,30000);command(`effect clear ${botName} minecraft:hunger`);
    const food=bot.food;before=marker();command(`give ${botName} bread 8`);
    await wait('eat',()=>action('eat_urgent',before)&&bot.food>food);log('E2E SURVIVAL eat PASS');
    const p=bot.entity.position.floored();
    command(`execute at ${botName} run fill ${p.x-6} ${p.y-1} ${p.z-6} ${p.x+6} ${p.y-1} ${p.z+6} stone`);
    command(`execute at ${botName} run fill ${p.x-6} ${p.y} ${p.z-6} ${p.x+6} ${p.y+2} ${p.z+6} air`);
    await delay(1000);before=marker();command(`execute at ${botName} run setblock ${p.x} ${p.y-1} ${p.z} lava`);
    await wait('lava escape',()=>action('escape_hazard',before)&&bot.entity.position.distanceTo(p)>2&&bot.health>0);log('E2E SURVIVAL lava PASS');
    command(`execute at ${botName} run setblock ${p.x} ${p.y-1} ${p.z} stone`);
    await wait('healthy for sleep',()=>bot.health>6,30000);
    command('time set night');const q=bot.entity.position.floored();
    command(`execute at ${botName} run fill ${q.x+2} ${q.y-1} ${q.z} ${q.x+2} ${q.y-1} ${q.z+1} stone`);
    command(`execute at ${botName} run setblock ${q.x+2} ${q.y} ${q.z} red_bed[facing=south,part=foot]`);
    command(`execute at ${botName} run setblock ${q.x+2} ${q.y} ${q.z+1} red_bed[facing=south,part=head]`);
    await wait('sleep',()=>bot.isSleeping,30000);log('E2E SURVIVAL sleep PASS');log('E2E SURVIVAL PASS');
  }catch(error){log(`E2E SURVIVAL FAIL: ${error.message}`);throw error;}
}
