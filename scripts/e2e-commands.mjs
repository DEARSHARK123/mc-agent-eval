import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');

export function commandsEnvironment(env, log = console.log) {
  if (env.E2E_COMMANDS !== '1') { log('E2E COMMANDS SKIP: set E2E_COMMANDS=1'); return false; }
  return true;
}

export async function runCommandsScenario({ app, command, delay, server, botName = 'Companion', log = console.log }) {
  const bot = app.bot;
  const run = params => app.registry.run('command', params);
  const at = ({ x, y, z }) => bot.blockAt(new Vec3(x, y, z))?.name ?? 'unknown';
  const issued = [];
  const feedback = [];
  server.stdout.on('data', chunk => {
    for (const line of String(chunk).split(/\r?\n/u)) {
      if (line.includes('issued server command')) issued.push(line);
      if (/Changed the block|Could not set|Successfully filled|no permission|do not have permission/iu.test(line)) feedback.push(line);
    }
  });
  const diag = label => {
    log(`DIAG ${label}: pos=${JSON.stringify(bot.entity.position)}`);
    for (const line of feedback.slice(-6)) log(`DIAG server: ${line}`);
  };
  // Records every system/chat message Companion sees — captures the authoritative
  // no-permission and command feedback text on the real server.
  const seen = [];
  bot.on('message', message => {
    const text = String(message?.toString?.() ?? message);
    seen.push(text);
    log(`DIAG msg: ${text}`);
  });
  let step = 'setup';
  try {
    const base = bot.entity.position.floored();
    command(`fill ${base.x - 4} ${base.y - 1} ${base.z - 4} ${base.x + 10} ${base.y - 1} ${base.z + 6} stone`);
    command(`fill ${base.x - 4} ${base.y} ${base.z - 4} ${base.x + 10} ${base.y + 8} ${base.z + 6} air`);
    await delay(500);

    // 1. setblock two blocks ahead of her really places the marker glass.
    step = 'setblock';
    const p1 = { x: base.x + 2, y: base.y, z: base.z };
    const r1 = await run({ kind: 'setblock', marker: 'light_blue_stained_glass', from: p1 });
    log(`DIAG setblock result=${JSON.stringify(r1)} blockAt=${at(p1)}`);
    diag('setblock');
    assert.equal(r1.ok, true, `setblock failed: ${JSON.stringify(r1.error)}`);
    assert.equal(r1.result.placed, true, `expected placed:true, got ${JSON.stringify(r1.result)}`);
    assert.equal(at(p1), 'light_blue_stained_glass');
    log('E2E COMMANDS setblock PASS');

    // 2. A 3x3x3 yellow fill materialises.
    step = 'fill';
    const f1 = { x: base.x + 4, y: base.y, z: base.z + 1 };
    const f2 = { x: base.x + 6, y: base.y + 2, z: base.z + 3 };
    const r2 = await run({ kind: 'fill', marker: 'yellow_stained_glass', from: f1, to: f2 });
    assert.equal(r2.ok, true, `fill failed: ${JSON.stringify(r2.error)}`);
    assert.equal(r2.result.placed, true, `expected placed:true, got ${JSON.stringify(r2.result)}`);
    assert.equal(at(f1), 'yellow_stained_glass');
    assert.equal(at(f2), 'yellow_stained_glass');
    log('E2E COMMANDS fill PASS');

    // 3. keep does not overwrite a stone block placed by the console.
    step = 'keep';
    const p3 = { x: base.x + 8, y: base.y, z: base.z };
    command(`setblock ${p3.x} ${p3.y} ${p3.z} stone`);
    await delay(500);
    const r3 = await run({ kind: 'setblock', marker: 'light_blue_stained_glass', from: p3 });
    assert.equal(r3.ok, true, `keep setblock failed: ${JSON.stringify(r3.error)}`);
    assert.equal(r3.result.placed, false, `expected placed:false, got ${JSON.stringify(r3.result)}`);
    assert.equal(at(p3), 'stone');
    log('E2E COMMANDS keep PASS');

    // 4. clear removes only the marker glass.
    step = 'clear';
    const r4 = await run({ kind: 'clear', marker: 'yellow_stained_glass', from: f1, to: f2 });
    assert.equal(r4.ok, true, `clear failed: ${JSON.stringify(r4.error)}`);
    assert.equal(r4.result.cleared, true, `expected cleared:true, got ${JSON.stringify(r4.result)}`);
    assert.equal(at(f1), 'air');
    assert.equal(at(f2), 'air');
    log('E2E COMMANDS clear PASS');

    // 5. A coordinate 33 blocks out is rejected before reaching the server.
    step = 'out_of_range';
    const far = { x: base.x + 33, y: base.y, z: base.z };
    assert.throws(() => run({ kind: 'setblock', marker: 'lime_stained_glass', from: far }), /out_of_range/);
    await delay(500);
    assert.ok(issued.some(line => line.includes('light_blue_stained_glass')),
      'server never echoed a whitelisted command (control)');
    assert.ok(!issued.some(line => line.includes('lime_stained_glass')),
      'rejected command reached the server');
    log('E2E COMMANDS out_of_range PASS');

    // 6. deop removes her permission; setblock now fails with no_permission.
    step = 'no_permission';
    const seenBefore = seen.length;
    command(`deop ${botName}`);
    await delay(1_500);
    const r6 = await run({ kind: 'setblock', marker: 'light_blue_stained_glass', from: { x: base.x + 2, y: base.y, z: base.z + 2 } });
    assert.equal(r6.ok, false, `expected failure without op, got ${JSON.stringify(r6)}`);
    assert.equal(r6.error?.code, 'no_permission', `expected no_permission, got ${JSON.stringify(r6.error)}`);
    const observed = seen.slice(seenBefore).find(text => /unknown (or incomplete )?command|do not have permission/iu.test(text));
    log(`E2E COMMANDS no-permission server text: ${JSON.stringify(observed ?? '(none observed)')}`);
    log('E2E COMMANDS no_permission PASS');
    log('E2E COMMANDS PASS');
  } catch (error) {
    log(`E2E COMMANDS FAIL: ${step}: ${error.message}`);
    throw error;
  }
}
