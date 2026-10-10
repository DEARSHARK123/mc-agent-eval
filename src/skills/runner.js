import { validateArgs } from './format.js';

export async function runSkill({ library, arbiter, name, args = {}, source = 'plan', traceId }) {
  if (!library.has(name)) return { ok: false, reason: 'unknown_skill' };
  const skill = library.get(name);
  const validated = validateArgs(skill.params, args);
  if (!validated.ok) return { ok: false, reason: 'invalid_args' };
  const intent = arbiter.submit({ source, label: name,
    program: { body: skill.body, params: skill.params, args: validated.args }, library, traceId });
  const outcome = await intent.done;
  if (outcome.status === 'completed' || outcome.status === 'failed') {
    library.recordOutcome(name, outcome.status === 'completed');
  }
  return { ok: outcome.status === 'completed', outcome };
}
