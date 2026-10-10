import { resolveClock } from './clock.js';

const POSITIVE = new Set(['对', '是', '是的', '嗯', '好', '好的', '可以', '行', '去吧', '做吧', 'ok']);
const NEGATIVE = new Set(['不', '不用', '不要', '算了', '别了']);

function cleanReply(value) {
  return String(value ?? '').trim().toLowerCase()
    .replace(/[。！？!?.,，、；;：:]+$/u, '')
    .trim();
}

export function parseShortReply(value) {
  let reply = cleanReply(value);
  for (;;) {
    if (POSITIVE.has(reply)) return 'yes';
    if (NEGATIVE.has(reply)) return 'no';
    if (!/[啊呀呢吧]$/u.test(reply)) return null;
    reply = reply.slice(0, -1).trim();
  }
}

export function createDialogue({ clock = {} } = {}) {
  const now = resolveClock(clock).now;
  const records = [];
  const spokenLines = [];
  let openQuestion = null;

  function expire() {
    if (openQuestion && now() - openQuestion.at >= 120_000) openQuestion = null;
  }

  return {
    record(speaker, text, kind = 'message') {
      if (speaker !== 'owner' && speaker !== 'companion') return;
      records.push({ speaker, text: String(text ?? ''), ts: now(), kind });
      while (records.length > 16) records.shift();
      if (speaker === 'companion') {
        spokenLines.push(String(text ?? ''));
        while (spokenLines.length > 8) spokenLines.shift();
      }
    },
    recent(limit = 8) {
      return records.slice(-limit).map(record => ({ ...record }));
    },
    recentLines() {
      return [...spokenLines];
    },
    seedLines(lines) {
      for (const line of lines ?? []) spokenLines.push(String(line ?? ''));
      while (spokenLines.length > 8) spokenLines.shift();
    },
    setQuestion(question) {
      if (!question || typeof question !== 'object') {
        openQuestion = null;
        return;
      }
      openQuestion = {
        type: question.type,
        action: question.action ?? null,
        skillName: question.skillName ?? null,
        args: question.args ?? {},
        at: question.at ?? now(),
      };
    },
    getQuestion() {
      expire();
      return openQuestion ? { ...openQuestion } : null;
    },
    clearQuestion() {
      openQuestion = null;
    },
    get openQuestion() {
      expire();
      return openQuestion ? { ...openQuestion } : null;
    },
  };
}

// Restart persistence: replay the last eight spoken lines so duplicates stay detected.
export function seedRecentSpeech(dialogue, eventlog) {
  const lines = (eventlog.query?.({ kind: 'speech', limit: Number.MAX_SAFE_INTEGER }) ?? [])
    .slice(-8)
    .map(event => event.payload?.text)
    .filter(text => typeof text === 'string');
  dialogue?.seedLines(lines);
  return lines;
}
