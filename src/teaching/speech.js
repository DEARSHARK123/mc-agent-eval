import { buildPersona, factLine } from '../persona.js';
import { allowsProvenanceClaim } from '../brain/agent.js';
import { displayName } from './lexicon.js';

function normalizeForDuplicate(text, situation) {
  return String(text ?? '').replace(new RegExp([situation.owner?.nickname, situation.owner?.playerName,
    situation.itemName, situation.action].filter(Boolean).map(value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'giu'), '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function duplicateFragment(left, right, situation) {
  const a = Array.from(normalizeForDuplicate(left, situation));
  const b = Array.from(normalizeForDuplicate(right, situation));
  let best = '';
  const rows = Array(b.length + 1).fill(0).map(() => Array(a.length + 1).fill(0));
  for (let i = 1; i <= b.length; i++) for (let j = 1; j <= a.length; j++) {
    if (b[i - 1] !== a[j - 1]) continue;
    rows[i][j] = rows[i - 1][j - 1] + 1;
    if (rows[i][j] > best.length) best = b.slice(i - rows[i][j], i).join('');
  }
  return best.length >= 6 ? best : null;
}

export function createSpeaker({ brain, mouth, dialogue, eventlog, relationship, ownerUuid, skillsMemory, capabilities }) {
  async function say(input, traceId) {
    const skills = skillsMemory();
    const owner = { playerName: relationship?.ownerName() ?? null, nickname: relationship?.nickname() ?? null };
    const situation = { item: null, itemName: null, reason: null, taughtBy: null, taughtWhen: null,
      previousTeachings: 0, skills, capabilities: capabilities(), ownerMessage: null, ...input, owner };
    if (situation.item && !situation.itemName) {
      situation.itemName = situation.item.split('、').map(displayName).join('、');
    }
    if (situation.reason?.blockName) situation.targetName = displayName(situation.reason.blockName);
    const events = (eventlog.query?.({ limit: Number.MAX_SAFE_INTEGER }) ?? [])
      .filter(event => event.payload?.from_owner || event.payload?.uuid?.toLowerCase() === ownerUuid ||
        event.payload?.teacherUuid === ownerUuid || ['teaching.failed', 'say'].includes(event.kind))
      .slice(-10).map(event => ({ kind: event.kind, ts: event.ts }));
    const recentLines = dialogue.recentLines();
    const memory = { skills, events, dialogue: dialogue.recent(8), recentLines };
    let generated = null;
    try {
      if (brain?.enabled) {
        generated = await brain.speak({ persona: buildPersona(owner), situation: { ...situation }, memory });
        const fragment = recentLines.map(line => duplicateFragment(generated, line, situation)).find(Boolean);
        if (fragment) generated = await brain.speak({ persona: buildPersona(owner),
          situation: { ...situation, avoid: [fragment] }, memory });
      }
    } catch {}
    const usedBrain = typeof generated === 'string' && Boolean(generated.trim()) && !generated.includes('主人')
      && allowsProvenanceClaim(generated, skills);
    let text = usedBrain ? generated : factLine(situation);
    if (situation.suppressSpeech) text = null;
    if (typeof text === 'string') text = text.replaceAll('主人', '');
    eventlog.append('say', { kind: situation.kind, usedBrain }, traceId);
    if (text !== null) {
      text = await mouth.say(text, traceId, { kind: usedBrain ? situation.kind : undefined }) ?? text;
      dialogue.record('companion', text, situation.kind);
    }
    return { kind: situation.kind, text };
  }
  return { say };
}
