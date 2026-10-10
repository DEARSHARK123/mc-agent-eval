// P0 · 模型组合能力摸底 runner — see README.md (Evaluation harness)
//
// Launch (from companion/, same env convention as the launcher):
//   node --env-file-if-exists=.env scripts/probe/run.mjs            # live probe
//   node scripts/probe/run.mjs --selftest                         # sim-only reference check
//   node scripts/probe/run.mjs --selftest --holdout               # holdout set (tasks 21–50)
//   node scripts/probe/run.mjs --selftest --set=p0r2              # P3 reuse holdout (51–80)
//   node scripts/probe/run.mjs --stub                             # dry-run: 1 A + 1 B cell, stub model
//   node scripts/probe/run.mjs --task=6 --model=inkling --reps=1  # filters
//   --paradigm=A  A cells only; --keep=jev  fold prior cells for listed keys in
//   NOTE: every flag needs the --key=value form — `--model x` is a silent
//   no-op (the arg parser only understands =).
//
// Reports: companion/.tmp/probe-p0|probe-p0r|probe-p0r2/results.json + summary.md
// Never commits; artifacts stay under .tmp/ (git-ignored).
// Post-T29 (v1/t29-fixes): paradigm A mirrors the production draft pipeline —
// normalizeDraft → validateDraft (legal), with legal_raw kept for comparison —
// and the prompt documents the P1 grammar + a user.names-style name slice.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createSim, createProbeContext, summarize, STEP_BUDGET } from './sim.js';
import { TASKS as BASE_TASKS } from './tasks.js';
import { buildModels, complete, pickByChat, pickByJev } from './adapters.js';
import { validateDraft } from '../../src/skills/format.js';
import { normalizeDraft } from '../../src/skills/repair.js';
import { mcData, resolveNamesInText } from '../../src/teaching/lexicon.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PARADIGM_B_STEPS = 15;
const PARADIGM_B_MAX_INVALID = 2;

// Post-T29 mirror (T29 A3): production's parseIntent injects user.names =
// names resolved from the message + a modest core slice of 1.20.4 ids. The
// probe copies the same CORE_NAMES approach — a constant list filtered against
// mcData at load, not the whole catalog.
const CORE_NAMES = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'oak_planks', 'spruce_planks', 'birch_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks',
  'cherry_planks', 'bamboo_planks',
  'stick', 'stone', 'cobblestone', 'dirt', 'grass_block', 'sand', 'gravel', 'clay', 'deepslate',
  'andesite', 'diorite', 'granite', 'sandstone', 'netherrack', 'obsidian', 'flint',
  'coal', 'charcoal', 'coal_ore', 'iron_ore', 'raw_iron', 'iron_ingot', 'iron_nugget',
  'gold_ore', 'raw_gold', 'gold_ingot', 'copper_ore', 'raw_copper', 'copper_ingot',
  'diamond_ore', 'diamond', 'emerald_ore', 'emerald', 'lapis_ore', 'lapis_lazuli',
  'redstone_ore', 'redstone', 'quartz', 'netherite_ingot',
  'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe',
  'wooden_axe', 'stone_axe', 'iron_axe', 'wooden_sword', 'stone_sword', 'iron_sword',
  'wooden_shovel', 'iron_shovel', 'wooden_hoe', 'iron_hoe',
  'shield', 'bucket', 'water_bucket', 'fishing_rod', 'shears', 'flint_and_steel', 'bow', 'arrow',
  'torch', 'ladder', 'string', 'leather', 'feather', 'bone', 'paper', 'book', 'glass', 'brick', 'stone_bricks',
  'bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'carrot', 'potato', 'baked_potato', 'wheat', 'wheat_seeds', 'beetroot', 'melon_slice', 'sweet_berries', 'egg',
  'chest', 'barrel', 'crafting_table', 'furnace', 'smoker', 'blast_furnace', 'campfire',
  'white_bed', 'red_bed', 'oak_door', 'oak_fence', 'white_wool', 'smooth_stone',
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime', 'drowned', 'husk', 'cave_spider',
  'cow', 'pig', 'sheep', 'chicken', 'villager',
].filter(name => Object.hasOwn(mcData.itemsByName, name)
  || Object.hasOwn(mcData.blocksByName, name) || Object.hasOwn(mcData.entitiesByName, name));

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const argList = name => typeof args[name] === 'string' ? args[name].split(',').map(s => s.trim()).filter(Boolean) : null;
const onlyTasks = argList('task')?.map(Number) ?? argList('tasks')?.map(Number);
const onlyModels = argList('model') ?? argList('models');
const onlyParadigms = argList('paradigm') ?? argList('paradigms');
const reps = Number(args.reps ?? 2);

// Task-set selection: --set=p0|p0r|p0r2 (or the legacy --holdout for p0r and
// --holdout2 for p0r2) swaps the task file and writes the report to a sibling
// directory so prior artifacts stay untouched. Applies to --selftest and
// live runs alike; default behavior unchanged.
const SETS = {
  p0:   { module: null,                  out: 'probe-p0',   spec: 'scripts/probe/tasks.js', flag: '',          label: 'P0 base (tasks 1–16, scripts/probe/tasks.js)' },
  p0r:  { module: './tasks-holdout.js',  out: 'probe-p0r',  spec: 'scripts/probe/tasks-holdout.js', flag: '--set=p0r',  label: 'P0r holdout (tasks 21–50, scripts/probe/tasks-holdout.js)' },
  p0r2: { module: './tasks-holdout2.js', out: 'probe-p0r2', spec: 'scripts/probe/tasks-holdout2.js', flag: '--set=p0r2', label: 'P0r2 reuse holdout (tasks 51–80, scripts/probe/tasks-holdout2.js)' },
  // One-shot generated set (规则一.7/一.8): tasks-p0r3.js is produced by
  // gen.mjs --seed=N and re-drawn every acceptance round.
  p0r3: { module: './tasks-p0r3.js', out: 'probe-p0r3', spec: 'scripts/probe/tasks-p0r3.js', flag: '--set=p0r3', label: 'P0r3 generated holdout (tasks 81–110, scripts/probe/tasks-p0r3.js)' },
};
const setKey = args.set === 'p0r3' ? 'p0r3'
  : ['p0r2', 'holdout2'].includes(args.set) || args.holdout2 ? 'p0r2'
  : ['p0r', 'holdout'].includes(args.set) || args.holdout ? 'p0r' : 'p0';
const SET = SETS[setKey];
const TASKS = setKey === 'p0' ? BASE_TASKS : (await import(SET.module)).TASKS;
const TASK_SET_LABEL = SET.label;
const OUT = join(ROOT, '.tmp', SET.out);
const REPORT_SPEC = SET.spec;

// ---------------------------------------------------------------- catalog ---

function renderParams(params) {
  const parts = Object.entries(params ?? {}).map(([name, rule]) => {
    let s = `${name}:${rule.type}`;
    if (rule.required) s += ' required';
    else if (rule.default !== undefined) s += `=${JSON.stringify(rule.default)}`;
    if (rule.enum) s += ` one of ${rule.enum.join('/')}`;
    if (rule.catalog) s += ` (1.20.4 ${rule.catalog === 'itemsByName' ? 'item' : rule.catalog === 'blocksByName' ? 'block' : 'entity'} name)`;
    if (rule.min !== undefined || rule.max !== undefined || rule.exclusiveMin !== undefined) {
      s += ` range ${rule.exclusiveMin !== undefined ? '>' + rule.exclusiveMin : rule.min}..${rule.max ?? '∞'}`;
    }
    return s;
  });
  return parts.join(', ');
}

function catalogText(registry) {
  return registry.list().map(name => {
    const d = registry.describe(name);
    return `- ${d.name}(${renderParams(d.params)})${d.free === true ? ' [free]' : ''}: ${d.description}`;
  }).join('\n');
}

// Post-P2 mirror: same constructs the production parseIntent prompt documents —
// $id.field refs incl. x/y/z, at:"$id"≡"id", find* at as search center,
// say text interpolation, $id.below/above offsets, body predicates, obtain, free queries.
// P3: the `call` line's trailing comment depends on whether the task seeds a
// skill library — names are listed when callables exist (spec 工作流A.3).
const grammarText = callable => `Skill-v2 JSON grammar — output ONLY {"name":"<snake_case>","body":[<nodes>]} (optionally "params" / "description"):
- Node shapes (exactly one key each):
  {"primitive":"<name>","params":{...},"id":"<id>","at":"<target>"}  // id stores the step result; at supplies x/y/z
  {"repeat":<1..16>,"body":[...]}                                   // repeat a sub-body
  {"if":<cond>,"then":[...],"else":[...]}                           // optional else
  {"fail":"<missing_item|target_not_found|cannot>"}                 // abort with a code
  {"call":"<skill>","args":{...}}                                   // ${callable}
  {"obtain":{"item":"<item>","count":<1..64>}}                      // ask the goal subsystem to get an item
- "at" binds coordinates from: an earlier step "id" or "$id" (equivalent; findBlock/findEntity/blockAt
  results carry x,y,z), "$id.below"/"$id.above" (one block under/above that id's result), or the special
  targets "$owner", "$self", "$self.below", "$self.front". On findBlock/findEntity, "at" re-centers the search
  there (32-block limit); on craft/smelt it names the station (table/furnace). When "at" is present, params
  must NOT contain x/y/z. Steps with a coordinate target auto-approach it (an implicit goTo into reach) —
  do NOT write a separate goTo just to get close.
- Declared "params" ({"name":{"type":"block|item|count|number","required"|"default"}}) may be referenced
  as "$name" in primitive params, call args, repeat, and hasItem.atLeast. A primitive param may instead be
  "$id.field" to read a field off an earlier visible id's result — field is one of
  uuid/entityName/blockName/name/count, or x/y/z on results with coordinates (a bare-number result like
  countItem's reads as "$id.count"). In "say" text, $id/$id.field/$owner interpolate to bound values.
- Conditions: {"found":"<id>"} | {"hasItem":"<item>","atLeast":<n>} | {"healthBelow":<1..20>} |
  {"foodBelow":<1..20>} | {"hasEffect":"<snake_case effect>"} | {"not":<cond>} | {"all":[...]} | {"any":[...]}.
  Conditions see inventory counts, the bot's body state, and earlier "id" bindings — not chest contents.
- Primitives marked [free] in the catalog are read-only world queries with no side effects — usable anywhere.
- Rules: primitive params are JSON scalars (string/number/boolean); item/block/entity names must be real
  Minecraft 1.20.4 names; "command" does not exist; keep bodies under ${STEP_BUDGET} executed steps.`;

// P3: tasks may seed a learned-skill library (task.skills = draft objects).
// The paradigm-A prompt lists them as a signature-only catalog — no bodies —
// so `used_call` measures whether the model CHOOSES reuse, not whether it can
// copy a reference implementation (spec 工作流A.2).
const renderSkillSignature = skill => `${skill.name}(${Object.entries(skill.params ?? {})
  .map(([name, rule]) => `${name}:${rule.type}${rule.required ? '*' : ''}`).join(', ')})`;

function skillsCatalogText(skills) {
  if (!skills?.length) return '';
  return '可调用技能（已学会，可整体调用；只给签名，内部步骤略——能复用就不必重写原语链）：\n'
    + skills.map(skill => `- call ${renderSkillSignature(skill)}: ${skill.description}`).join('\n') + '\n\n';
}

function promptA(task, sim, registry) {
  const system = '你在为一个 Minecraft bot 编写 skill-v2 技能程序（JSON DSL）。'
    + '程序会在一个模拟器里逐步执行。只输出一个 JSON 对象，不要解释。';
  // user.names mirror: names parsed out of the task text plus the core slice.
  const names = [...new Set([...resolveNamesInText(`${task.title} ${task.description}`), ...CORE_NAMES])];
  const skills = task.skills ?? [];
  const callable = skills.length
    ? `call a learned skill — one of: ${skills.map(s => s.name).join(', ')} (see 可调用技能 below)`
    : 'no other skills exist here';
  const user = `${grammarText(callable)}\n\n可用原语（白名单；标 [free] 的是只读世界查询）：\n${catalogText(registry)}\n\n`
    + skillsCatalogText(skills)
    + `世界初始状态：\n${summarize(sim)}\n\n`
    + `names（任务涉及名 + 常用 1.20.4 id 切片，catalog 类参数优先从中选取）：${names.join(', ')}\n\n`
    + `任务：${task.description}\n\n`
    + '输出格式：{"name":"...","body":[...]}';
  return { system, user };
}

// ---------------------------------------------------------------- helpers ---

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const SECRETS = ['BRAIN_API_KEY', 'OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'BRAIN_BASE_URL'];
function redact(text) {
  let out = String(text ?? '');
  for (const name of SECRETS) {
    const v = process.env[name];
    if (v && v.length > 8) out = out.split(v).join('[REDACTED]');
  }
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]').replace(/apikey_[A-Za-z0-9_-]{8,}/g, 'apikey_[REDACTED]');
  return out.slice(0, 1200);
}

function tokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  // OpenAI shape (prompt_tokens/completion_tokens) + Gemini usageMetadata
  // shape (promptTokenCount/candidatesTokenCount).
  return { input: usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? null,
    output: usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? null };
}

// ------------------------------------------------------------- paradigm A ---

// P3: collect every `call` target in a draft (walks repeat/if sub-bodies) so
// cells record `used_call`/`call_targets` — including calls to decoys in
// drafts that later fail validation (skill_choice signal, spec 工作流A).
function collectCallTargets(body, out = []) {
  if (!Array.isArray(body)) return out;
  for (const node of body) {
    if (!node || typeof node !== 'object') continue;
    if (typeof node.call === 'string') out.push(node.call);
    collectCallTargets(node.body, out);
    collectCallTargets(node.then, out);
    collectCallTargets(node.else, out);
  }
  return out;
}

const seededSkills = task => task.skills ?? [];
// The same drafts feed BOTH the interpreter's `library` (call execution) and
// validateDraft's `skills` option (call-graph validation) — one source of
// truth, exactly like production's skill library (spec 工作流A.1).
const seededLibrary = task => new Map(seededSkills(task).map(skill => [skill.name, skill]));

async function runCellA(model, task, rep) {
  const sim = createSim();
  task.setup(sim);
  const { registry, executeBody } = createProbeContext(sim);
  const skills = seededSkills(task);
  const library = seededLibrary(task);
  const cell = { model: model.key, paradigm: 'A', task: task.id, level: task.level, rep,
    parsed: false, legal: false, legal_raw: false, repairs: [], executed: false, success: false, steps: 0,
    latencyMs: 0, tokens: null, error: null, sample: null };
  if (task.inexpressible) cell.inexpressible = task.inexpressible;
  if (skills.length) cell.seeded_skills = skills.map(skill => skill.name);
  if (model.kind === 'stub') {
    cell.stub = true;
    cell.parsed = true;
    const draft = { name: `probe_t${task.id}`, body: task.reference ?? [] };
    const calls = collectCallTargets(draft.body);
    if (calls.length) { cell.used_call = true; cell.call_targets = calls; }
    cell.legal_raw = validateDraft(draft, { registry, skills }).ok;
    const { draft: normalized, repairs } = normalizeDraft(draft, { registry });
    cell.repairs = repairs;
    cell.legal = validateDraft(normalized, { registry, skills }).ok;
    const run = await executeBody(normalized, { library });
    cell.executed = run.executed; cell.steps = run.steps;
    cell.success = !run.error && Boolean(task.success(sim));
    cell.error = run.error ?? (cell.success ? null : { code: 'success_predicate' });
    cell.sample = JSON.stringify({ name: `probe_t${task.id}`, body: task.reference });
    return cell;
  }
  const { system, user } = promptA(task, sim, registry);
  const resp = await complete(model, { system, user });
  cell.latencyMs = Math.round(resp.latencyMs);
  cell.tokens = tokenUsage(resp.usage);
  cell.sample = redact(resp.text);
  if (!resp.ok) { cell.error = { code: 'api_error', status: resp.status }; return cell; }
  const draft = extractJson(resp.text);
  cell.parsed = Boolean(draft && typeof draft === 'object' && Array.isArray(draft.body));
  if (!cell.parsed) { cell.error = { code: 'unparsed' }; return cell; }
  // Recorded from the RAW parsed draft: an illegal call draft still shows the
  // model's skill choice (e.g. a decoy pick) even when it can't execute.
  const calls = collectCallTargets(draft.body);
  if (calls.length) { cell.used_call = true; cell.call_targets = calls; }
  // Post-T29 mirror (T29 A1): production runs normalizeDraft before
  // validateDraft at the model-facing entry points. `legal` = valid AFTER
  // normalize; `legal_raw` = what the raw draft would have scored pre-T29 —
  // the delta is the sanitizer's contribution. Single-shot only: the
  // production teach_repair retry is deliberately NOT reproduced here.
  cell.legal_raw = validateDraft(draft, { registry, skills }).ok;
  const { draft: normalized, repairs } = normalizeDraft(draft, { registry });
  cell.repairs = repairs;
  const check = validateDraft(normalized, { registry, skills });
  cell.legal = check.ok;
  if (!check.ok) { cell.error = { code: 'illegal', errors: check.errors.slice(0, 4) }; return cell; }
  const run = await executeBody(normalized, { library });
  cell.steps = run.steps;
  cell.executed = run.executed;
  cell.error = run.error;
  cell.success = Boolean(task.success(sim));
  return cell;
}

// ------------------------------------------------------------- paradigm B ---

async function runCellB(model, task) {
  const sim = createSim();
  task.setup(sim);
  const { registry } = createProbeContext(sim);
  const cell = { model: model.key, paradigm: 'B', task: task.id, level: task.level, rep: 0,
    parsed: true, legal: true, executed: true, success: false, steps: 0,
    invalidPicks: 0, latencyMs: 0, tokens: { input: 0, output: 0 }, picks: [], error: null, sample: null };
  let calls = 0, totalTok = { input: 0, output: 0 };
  const history = [];
  while (cell.steps < PARADIGM_B_STEPS && invalidGuard(cell) < PARADIGM_B_MAX_INVALID) {
    if (task.success(sim)) break;
    const options = task.candidates(sim).slice(0, 8);
    let choice = null;
    if (model.kind === 'jev') {
      const resp = await pickByJev(model, { task, state: summarize(sim), options, history });
      cell.latencyMs += resp.latencyMs ?? 0;
      calls++;
      if (resp.ok) {
        choice = resp.answers?.pick?.choice ?? null;
        if (!cell.sample) cell.sample = redact(JSON.stringify(resp.answers));
      } else { cell.error = { code: `jev_${resp.error?.code ?? 'failed'}` }; break; }
    } else if (model.kind === 'stub') {
      choice = options[0]?.key;
    } else {
      const resp = await pickByChat(model, { task, stateText: summarize(sim), options, history });
      cell.latencyMs += resp.latencyMs ?? 0;
      calls++;
      const u = tokenUsage(resp.usage);
      if (u) { totalTok.input += u.input ?? 0; totalTok.output += u.output ?? 0; }
      if (!resp.ok) { cell.error = { code: 'api_error', status: resp.status }; break; }
      if (!cell.sample) cell.sample = redact(resp.text);
      const parsed = extractJson(resp.text);
      choice = parsed && typeof parsed.choice === 'string' ? parsed.choice : null;
    }
    const option = options.find(o => o.key === choice);
    if (!option) { cell.invalidPicks++; cell.picks.push({ key: choice ?? '(unparsed)', ok: false }); history.push(`${choice ?? 'unparsed'}(invalid)`); continue; }
    if (option.done || option.key === 'done') { cell.picks.push({ key: 'done', ok: true }); break; }
    const result = await registry.run(option.primitive, option.params);
    cell.steps++;
    history.push(`${option.key}${result.ok ? '' : '(failed)'}`);
    cell.picks.push({ key: option.key, ok: result.ok, ...(result.ok ? {} : { error: result.error?.code ?? result.error?.message }) });
  }
  cell.success = Boolean(task.success(sim));
  cell.tokens = calls && model.kind !== 'jev' ? totalTok : (calls ? cell.tokens : null);
  if (cell.invalidPicks >= PARADIGM_B_MAX_INVALID && !cell.success) cell.error = { code: 'invalid_picks' };
  if (!cell.success && !cell.error && cell.steps >= PARADIGM_B_STEPS) cell.error = { code: 'step_budget' };
  return cell;
}
const invalidGuard = cell => cell.invalidPicks;

// ---------------------------------------------------------------- selftest ---

async function selftest() {
  const rows = [];
  let pass = 0;
  for (const task of TASKS) {
    const sim = createSim();
    task.setup(sim);
    const { registry, executeBody } = createProbeContext(sim);
    if (task.inexpressible) {
      rows.push({ task: task.id, level: task.level, status: 'inexpressible', note: task.inexpressible });
      continue;
    }
    const draft = { name: `probe_t${task.id}`, body: task.reference };
    // P3: seeded-skill tasks validate the call graph against the seeded
    // drafts and execute with them as the library — reference bodies use
    // `call` where the spec expects it and must really run.
    const skills = seededSkills(task);
    const check = validateDraft(draft, { registry, skills });
    if (!check.ok) {
      rows.push({ task: task.id, level: task.level, status: 'FAIL', phase: 'validateDraft', errors: check.errors });
      continue;
    }
    const run = await executeBody(draft, { library: seededLibrary(task) });
    const ok = run.executed && task.success(sim);
    rows.push({ task: task.id, level: task.level, status: ok ? 'PASS' : 'FAIL',
      steps: run.steps, error: run.error, success: Boolean(task.success(sim)),
      ...(skills.length ? { seeded: skills.map(skill => skill.name) } : {}) });
    if (ok) pass++;
  }
  return { pass, total: TASKS.length, rows };
}

// ------------------------------------------------------------------ report ---

function rate(cells, pred) {
  const n = cells.filter(c => !c.inexpressible);
  return n.length ? n.filter(pred).length / n.length : null;
}

function summarizeResults(cells, skipped, selftestRows) {
  const lines = [];
  lines.push('# P0 probe summary', '');
  lines.push(`Launch: \`node --env-file-if-exists=.env scripts/probe/run.mjs${SET.flag ? ` ${SET.flag}` : ''}\` (repo: companion/)`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Task set: ${TASK_SET_LABEL}`, '');
  if (skipped.length) {
    lines.push('## Models skipped or not run', '');
    for (const s of skipped) lines.push(`- ${s.key}: ${s.reason}`);
    lines.push('');
  }
  lines.push('## Selftest (sim + real interpreter/validator, reference bodies)', '');
  for (const r of selftestRows) {
    lines.push(`- T${r.task} (${r.level}): ${r.status}${r.steps !== undefined ? ` in ${r.steps} steps` : ''}${r.error ? ` — ${r.error.code ?? r.error.message}` : ''}${r.note ? ` — ${r.note}` : ''}`);
  }
  lines.push('');
  const live = cells.filter(c => !c.stub);
  const stub = cells.filter(c => c.stub);
  const models = [...new Set(live.map(c => c.model))];
  const levels = ['L1', 'L2', 'L3'];
  if (models.length) {
    lines.push('## Headline rates (inexpressible cells excluded)', '');
    lines.push('| model | paradigm | level | cells | legal_raw rate | legal rate | success rate | avg steps |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const m of models) for (const p of ['A', 'B']) for (const lvl of levels) {
      const group = live.filter(c => c.model === m && c.paradigm === p && c.level === lvl && !c.inexpressible);
      if (!group.length) continue;
      // 合法率 = legal/parsed per spec; post-T29 `legal` is validateDraft AFTER
      // normalizeDraft, `legal_raw` is the pre-T29 measure (validate alone);
      // success = success/cells
      const parsed = group.filter(c => c.parsed).length;
      const legal = p === 'A' ? (parsed ? group.filter(c => c.legal).length / parsed : null) : null;
      const legalRaw = p === 'A' ? (parsed ? group.filter(c => c.legal_raw).length / parsed : null) : null;
      const succ = rate(group, c => c.success);
      const steps = group.reduce((a, c) => a + c.steps, 0) / group.length;
      lines.push(`| ${m} | ${p} | ${lvl} | ${group.length} | ${legalRaw === null ? '—' : (legalRaw * 100).toFixed(0) + '%'} | ${legal === null ? '—' : (legal * 100).toFixed(0) + '%'} | ${(succ * 100).toFixed(0)}% | ${steps.toFixed(1)} |`);
    }
    lines.push('');
    // T29 A1 mirror: which normalizeDraft rules fired on which paradigm-A cells.
    const repaired = live.filter(c => c.paradigm === 'A' && c.repairs?.length);
    if (repaired.length) {
      lines.push('## normalizeDraft repairs fired (paradigm A)', '');
      for (const c of repaired) {
        const rules = [...new Set(c.repairs)];
        lines.push(`- ${c.model} T${c.task} rep${c.rep}: ${rules.join(', ')}${rules.length < c.repairs.length ? ` (x${c.repairs.length} sites)` : ''}${c.legal ? '' : ' — still illegal'}${c.success ? '' : ' — no success'}`);
      }
      lines.push('');
    }
    lines.push('## Endpoint/config notes', '');
    for (const m of models) {
      const group = live.filter(c => c.model === m);
      const dead = group.filter(c => c.error?.code === 'api_error');
      if (dead.length === group.length && group.length) {
        const statuses = [...new Set(dead.map(c => c.error?.status ?? 'timeout'))].join(',');
        lines.push(`- ${m}: ALL ${group.length} cells failed at the endpoint level (api_error, http=${statuses}) — this measures reachability/config, NOT model capability.`);
      } else if (dead.length >= Math.max(2, group.length * 0.8)) {
        const statuses = [...new Set(dead.map(c => c.error?.status ?? 'timeout'))].join(',');
        lines.push(`- ${m}: ${dead.length}/${group.length} cells api_error (http=${statuses}) — quota-limited mid-run; the few live cells are real but rates are denominator-heavy on circuit_open failures.`);
      }
    }
    lines.push('');
    lines.push('## Decision-line check (spec §decision thresholds)', '');
    for (const m of models) {
      const aL2 = live.filter(c => c.model === m && c.paradigm === 'A' && c.level === 'L2' && !c.inexpressible);
      if (!aL2.length) continue;
      const s = rate(aL2, c => c.success);
      const allDead = aL2.every(c => c.error?.code === 'api_error');
      const verdict = allDead ? 'n/a — endpoint unreachable, no drafts produced'
        : s >= 0.6 ? '≥60% → 大脑可直接在 0 层组合，P3 按完整组合器设计'
        : s >= 0.3 ? '30–60% → 只允许带 if/repeat 的中等组合，L3 走分步问/规划器'
        : '<30% → 0 层不对模型开放，P1 仍做地基';
      lines.push(`- ${m} L2 paradigm-A success: ${(s * 100).toFixed(0)}% → ${verdict}`);
      const bL2 = live.filter(c => c.model === m && c.paradigm === 'B' && c.level === 'L2' && !c.inexpressible);
      if (bL2.length) {
        const bs = rate(bL2, c => c.success);
        lines.push(`  - 对照 B L2: ${(bs * 100).toFixed(0)}%${bs > s ? '（B 好于 A → 缺的是长程序合成，倾向逐步+校验）' : ''}`);
      }
    }
    lines.push('');

    // P3 call-adoption block: on tasks with a seeded skill library, did the
    // model choose `call`, and did it pick the right skill? Off-reference
    // targets (decoys like kill_far/fetch_y, or smelt_at on T79) are flagged
    // per cell — they are the skill_choice signal, not noise (spec §判定线).
    const seededIds = new Set(TASKS.filter(t => t.skills?.length).map(t => t.id));
    const callCells = live.filter(c => c.paradigm === 'A' && c.used_call);
    if (seededIds.size || callCells.length) {
      lines.push('## Call adoption (P3 reuse channel)', '');
      const refCalls = id => new Set(collectCallTargets(TASKS.find(t => t.id === id)?.reference));
      lines.push('| model | seeded-task A cells | used_call | success with call | success without |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const m of models) {
        const group = live.filter(c => c.model === m && c.paradigm === 'A' && seededIds.has(c.task) && !c.inexpressible);
        if (!group.length) continue;
        const used = group.filter(c => c.used_call);
        const unused = group.filter(c => !c.used_call);
        const fmt = list => list.length ? `${list.filter(c => c.success).length}/${list.length}` : '—';
        lines.push(`| ${m} | ${group.length} | ${used.length}/${group.length} | ${fmt(used)} | ${fmt(unused)} |`);
      }
      lines.push('');
      const notes = callCells.filter(c => seededIds.has(c.task));
      if (notes.length) {
        lines.push('Call targets observed on seeded tasks (`*` = off-reference pick — decoy or trap):', '');
        for (const c of notes) {
          const expected = refCalls(c.task);
          const marks = c.call_targets.map(name => expected.has(name) ? name : `${name}*`);
          lines.push(`- ${c.model} T${c.task} rep${c.rep}: ${marks.join(', ')} — legal=${c.legal} success=${c.success}`);
        }
        lines.push('');
      }
      const wild = callCells.filter(c => !seededIds.has(c.task));
      if (wild.length) {
        lines.push('Call nodes on tasks with NO seeded library (unknown_skill on execution):', '');
        for (const c of wild) lines.push(`- ${c.model} T${c.task} rep${c.rep}: ${c.call_targets.join(', ')} — legal=${c.legal} success=${c.success}`);
        lines.push('');
      }
    }
    lines.push('## Probe deviations from spec (all documented, intentional)', '');
    lines.push('- inkling: the spec literally says base `https://openrouter.ai/api` + model `openrouter/thinkingmachines/inkling:free`; both 404. Used the real endpoint `/api/v1` + id `thinkingmachines/inkling:free` (the `openrouter/` prefix is the pi-ai namespaced form). Result is still api_error: the model is gated to "agentic harnesses" (HTTP 403) — it cannot be probed over the raw API with this key.');
    lines.push('- BRAIN_*: dispatched on BRAIN_PROVIDER — `gemini` → createGeminiProvider (generateContent, thinking=BRAIN_PARSE_THINKING + responseMimeType json, same as the real brain parse path in src/brain/llm.js), `openai`/unset → createOpenAIProvider. Cell key is the real BRAIN_MODEL name, not a fixed label. The prior run\'s `deepseek-flash` cells hit the Gemini endpoint with the OpenAI wire format (provider ignored) — invalid measurement, dropped on merge. BRAIN_FALLBACK_MODELS are probed as separate rows keyed by their real model names (per-model attribution), not via in-request failover like llm.js — a deliberate difference; at runtime the brain would silently fall back, here each model gets its own rate.');
    lines.push('- Circuit breaker: after 2 consecutive api_error cells per model+paradigm, remaining cells are recorded as api_error(circuit_open) without re-calling — they still count as failures in denominators.');
    lines.push('- Sim semantics: give/attack navigate inside their own impl (GoalFollow parity), deposit/withdraw/sleep find-and-approach, and dig/place/craft/smelt auto-approach via the same ensureReach the arbiter calls — drafts no longer need explicit approach steps either side.');
    lines.push('- Post-T29 paradigm-A mirror (this run): `normalizeDraft` runs before `validateDraft` exactly like the llm.js teach branch — `legal` is post-normalize, `legal_raw` the raw score, `repairs` lists fired rules. The production teach_repair retry is NOT reproduced: cells stay single-shot. The prompt now documents the P1 grammar (`$id.field` refs, `$id.below/above`, healthBelow/foodBelow/hasEffect, obtain 1..64, free queries) and injects a names slice (resolveNamesInText(task) + CORE_NAMES, same approach as llm.js user.names). Sim gained impls for the P1 free query primitives (pos/inventory/heldItem/body — `body` is what foodBelow/healthBelow/hasEffect evaluate through) and the catalog marks [free]; the proposed findEntity/blockAt overrides stay so the 16-block sight range and null-on-miss semantics match the card.');
    lines.push('- `obtain` nodes fail with obtain_unavailable (the goal subsystem is out of scope for the probe).');
    if (setKey === 'p0r2') {
      lines.push('- P0r2 set (P3): sim world enlarged to 64x10x64 to host the (40,3,40) slope region; `at`-bound drafts probe with placeholder coordinates, so format.js asks checked() for {deferAmbit:true} — run()/query() still enforce real ambit. aOnly tasks have no B cells (call is invisible to the B picker by design).');
    }
    lines.push('');
    const inex = live.filter(c => c.inexpressible);
    if (inex.length) {
      lines.push('## Inexpressible findings', '');
      const t16 = inex[0];
      lines.push(`- T${t16.task}: ${t16.inexpressible} — paradigm-A cells excluded from rates (${inex.length} cells, e.g. ${t16.model}: parsed=${t16.parsed} legal=${t16.legal} success=${t16.success})`);
      lines.push('');
    }
    lines.push('## Raw response samples', '');
    for (const m of models) {
      const samples = live.filter(c => c.model === m && c.sample).slice(0, 3);
      lines.push(`### ${m}`);
      for (const s of samples) {
        lines.push(`**T${s.task} ${s.paradigm} rep${s.rep}** (parsed=${s.parsed} legal=${s.legal} success=${s.success}):`);
        lines.push('```');
        lines.push(s.sample.split('\n').slice(0, 30).join('\n'));
        lines.push('```');
      }
      lines.push('');
    }
  }
  if (stub.length) {
    lines.push('## Stub dry-run (not counted in rates)', '');
    for (const c of stub) lines.push(`- T${c.task} ${c.paradigm}: parsed=${c.parsed} legal=${c.legal} executed=${c.executed} success=${c.success} steps=${c.steps}`);
    lines.push('');
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------- main ---

async function main() {
  mkdirSync(OUT, { recursive: true });

  // --merge=<file,file,...>: fold cells from sibling results files under OUT
  // into one report. For each cell key (model|paradigm|task|rep) a live cell
  // beats a dead api_error record — this exists for quota-interrupted runs
  // where the endpoint 429s mid-sweep and the rest is re-run minutes later.
  if (args.merge) {
    const files = argList('merge') ?? [];
    const byKey = new Map();
    const skippedBy = new Map();
    let selfRows = [];
    for (const file of files) {
      const r = JSON.parse(readFileSync(join(OUT, file), 'utf8'));
      for (const s of r.skipped ?? []) skippedBy.set(s.key, s);
      selfRows = r.selftest ?? selfRows;
      for (const c of r.cells ?? []) {
        const k = `${c.model}|${c.paradigm}|${c.task}|${c.rep}`;
        const dead = x => x?.error?.code === 'api_error';
        const prev = byKey.get(k);
        if (!prev || (dead(prev) && !dead(c))) byKey.set(k, c);
      }
    }
    const cells = [...byKey.values()].sort((a, b) =>
      a.task - b.task || (a.paradigm === b.paradigm ? a.rep - b.rep : a.paradigm === 'A' ? -1 : 1));
    const skipped = [...skippedBy.values()];
    const report = { generated: new Date().toISOString(), spec: REPORT_SPEC,
      taskSet: TASK_SET_LABEL,
      budgets: { paradigmASteps: STEP_BUDGET, paradigmBSteps: PARADIGM_B_STEPS, repsA: reps },
      skipped, selftest: selfRows, cells, mergedFrom: files };
    writeFileSync(join(OUT, 'results.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(OUT, 'summary.md'), summarizeResults(cells, skipped, selfRows));
    const live = cells.filter(c => c.error?.code !== 'api_error');
    console.log(`merged ${files.join(', ')} → ${cells.length} cells (${live.length} live)`);
    return;
  }

  if (args.selftest) {
    console.log(`task set: ${TASK_SET_LABEL}`);
    const r = await selftest();
    for (const row of r.rows) {
      console.log(`T${String(row.task).padStart(2)} ${row.level} ${row.status}${row.steps !== undefined ? ` (${row.steps} steps)` : ''}${row.error ? ` — ${JSON.stringify(row.error)}` : ''}${row.errors ? ` — ${row.errors.join('; ')}` : ''}${row.note ? ` — ${row.note}` : ''}`);
    }
    console.log(`\nselftest: ${r.pass}/${r.total - r.rows.filter(x => x.status === 'inexpressible').length} expressible tasks pass (${r.rows.filter(x => x.status === 'inexpressible').length} inexpressible)`);
    return;
  }

  const self = await selftest(); // always validate sim before burning model calls
  const selfPass = self.rows.every(r => r.status !== 'FAIL');
  console.log(`selftest: ${selfPass ? 'all expressible tasks pass' : 'FAILURES — see summary'}`);

  let { models, skipped } = buildModels(process.env);
  if (args.stub || models.filter(m => m.kind === 'chat').length === 0) {
    if (!args.stub) skipped.push(...models.map(m => ({ key: m.key, reason: 'no chat-capable key for this probe run' })));
    models = [{ key: 'stub', kind: 'stub', paradigms: ['A', 'B'] }];
  }
  if (onlyModels) {
    for (const m of models.filter(m => !onlyModels.includes(m.key))) {
      skipped.push({ key: m.key, reason: 'excluded by --model filter this run (prior cells kept if --keep listed it)' });
    }
    models = models.filter(m => onlyModels.includes(m.key));
  }
  // --task order is execution order (lets a caller run L2 first when a model's
  // quota might die mid-run).
  const tasks = onlyTasks ? onlyTasks.map(id => TASKS.find(t => t.id === id)).filter(Boolean) : TASKS;

    const cells = [];
  // Circuit breaker: after 2 consecutive api_error cells for a model+paradigm
  // the endpoint is presumed dead — record the remaining cells as api_error
  // failures (they count in denominators) instead of burning timeouts.
  const circuitOpen = (model, paradigm) => {
    const prior = cells.filter(c => c.model === model.key && c.paradigm === paradigm);
    return prior.length >= 2 && prior.slice(-2).every(c => c.error?.code === 'api_error');
  };
  const deadCell = (model, task, paradigm, rep) => ({ model: model.key, paradigm, task: task.id,
    level: task.level, rep, parsed: false, legal: false, legal_raw: false, repairs: [], executed: false, success: false, steps: 0,
    latencyMs: 0, tokens: null, error: { code: 'api_error', status: 'circuit_open' },
    sample: null, circuit: true, ...(paradigm === 'A' && task.inexpressible ? { inexpressible: task.inexpressible } : {}) });

  for (const model of models) {
    for (const task of tasks) {
      if (model.paradigms.includes('A') && (!onlyParadigms || onlyParadigms.includes('A'))) {
        const n = model.kind === 'stub' ? 1 : reps;
        for (let rep = 0; rep < n; rep++) {
          const t0 = Date.now();
          const cell = circuitOpen(model, 'A') ? deadCell(model, task, 'A', rep) : await runCellA(model, task, rep);
          cells.push(cell);
          console.log(`A ${model.key} T${task.id} rep${rep}: parsed=${cell.parsed} legal=${cell.legal} ok=${cell.success} steps=${cell.steps} ${Date.now() - t0}ms${cell.error ? ` err=${cell.error.code}` : ''}`);
        }
      }
      // P3: aOnly tasks (seeded-skill tasks 75–80) skip paradigm B — its
      // candidates only expose primitives, `call` is invisible there, so a B
      // cell measures nothing (their candidates() returns [] anyway).
      if (model.paradigms.includes('B') && !task.aOnly && (!onlyParadigms || onlyParadigms.includes('B'))) {
        const t0 = Date.now();
        const cell = circuitOpen(model, 'B') ? deadCell(model, task, 'B', 0) : await runCellB(model, task);
        cells.push(cell);
        console.log(`B ${model.key} T${task.id}: ok=${cell.success} steps=${cell.steps} invalid=${cell.invalidPicks} ${Date.now() - t0}ms${cell.error ? ` err=${cell.error.code}` : ''}`);
      }
    }
  }

  // --keep=<key,key>: fold in cells from the previous results.json for models
  // NOT re-run this time (e.g. `--keep=jev` while re-running only BRAIN_*).
  // Cells for keys not listed are dropped — that's how stale labels leave.
  const keepKeys = argList('keep');
  if (keepKeys?.length) {
    try {
      const prev = JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8'));
      const kept = (prev.cells ?? []).filter(c => keepKeys.includes(c.model));
      cells.push(...kept);
      console.log(`merge: kept ${kept.length} prior cells (${keepKeys.join(', ')})`);
    } catch (error) {
      console.warn(`merge: no usable prior results.json (${error.message}) — this run's cells only`);
    }
  }

  const report = { generated: new Date().toISOString(), spec: REPORT_SPEC,
    taskSet: TASK_SET_LABEL,
    budgets: { paradigmASteps: STEP_BUDGET, paradigmBSteps: PARADIGM_B_STEPS, repsA: reps },
    skipped, selftest: self.rows, cells };
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT, 'summary.md'), summarizeResults(cells, skipped, self.rows));
  console.log(`\nwrote ${join(OUT, 'results.json')} and summary.md (${cells.length} cells)`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
