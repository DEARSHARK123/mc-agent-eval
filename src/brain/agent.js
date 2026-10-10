import { buildPersona } from '../persona.js';
import { createGameTools, lookAround, skillOrigin } from './tools.js';

export function allowsProvenanceClaim(text, skills) {
  if (!/教过我|教我的|教会了我|教给我|是[^。！？\n]*教的/u.test(text ?? '')) return true;
  return skills.some(s => s.provenance?.some(p => p.route === 'taught') &&
    [s.name, s.description].some(value => typeof value === 'string' && value.trim() && text.includes(value)));
}

export const RECOVER_REASONS = new Set(['escalated', 'low_confidence', 'repeated_failure', 'no_candidate', 'deadline', 'step_budget']);
export function createGameAgent({ pi, timeoutMs = 20000, maxToolRounds = 6, eventlog, ...dependencies }) {
  let active;
  const log = (kind, payload, traceId) => pi.log ? pi.log(kind, payload, traceId) : eventlog?.append(kind, payload, traceId);
  return { get enabled() { return pi?.enabled === true; }, available: () => pi?.available() === true,
    close: () => pi?.close(),
    cancel() { if (!active) return false; active.stop('cancelled'); return true; },
    async run({ message, mode = 'chat', owner, recent = [], recovery, traceId }) {
      if (active || !pi?.available()) return { fallback: true };
      const controller = new AbortController();
      let last, rounds = 0, reason, first, callStart = Date.now(), finish, aborting;
      const settled = new Promise(resolve => { finish = resolve; });
      const state = { stop(value) {
        if (reason) return;
        reason = value; controller.abort();
        aborting = pi.command('abort').catch(() => {});
        finish();
      } };
      active = state;
      const onEvent = event => {
        if (event.type === 'message_start' && event.message?.role === 'assistant') { callStart = Date.now(); first = undefined; }
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta' && first === undefined) first = Date.now() - callStart;
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          last = event.message;
          const ok = !['error', 'aborted'].includes(last.stopReason);
          const code = /429/u.test(last.errorMessage ?? '') ? 'http_429' : 'request_failed';
          log('agent.call', { model: pi.model, mode, ok, ...(ok ? {} : { error_code: reason === 'timeout' ? 'timeout' : code }),
            total_ms: Date.now() - callStart, ...(first === undefined ? {} : { first_token_ms: first }),
            ...(Number.isFinite(last.usage?.input) ? { input_tokens: last.usage.input } : {}),
            ...(Number.isFinite(last.usage?.output) ? { output_tokens: last.usage.output } : {}) }, traceId);
          if (last.stopReason === 'error') state.stop(code);
          else if (!pi.available() && last.stopReason === 'toolUse') state.stop('quota');
        }
        if (event.type === 'tool_execution_start' && ++rounds >= maxToolRounds) state.stop('tool_limit');
        if (event.type === 'agent_settled') finish();
      };
      const onExit = () => { reason ??= 'request_failed'; controller.abort(); finish(); };
      const onReport = report => { if (report.kind === 'tools_mismatch') state.stop('tools_mismatch'); };
      const onResult = result => { if (['cancelled', 'preempted'].includes(result.details?.status) || result.details?.error === 'cancelled') state.stop('cancelled'); };
      pi.events.on('event', onEvent); pi.events.on('exit', onExit); pi.events.on('report', onReport);
      pi.bridge.events.on('tool_result', onResult);
      const timer = setTimeout(() => state.stop('timeout'), timeoutMs);
      try {
        const reset = await Promise.race([pi.command('new_session'), settled.then(() => null)]);
        if (reset?.cancelled) throw new Error('reset cancelled');
        if (!reason) {
          await Promise.race([pi.command('set_auto_retry', { enabled: false }), settled]);
          if (reason) await settled;
        }
        if (!reason) {
          const tools = createGameTools({ ...dependencies, eventlog, traceId });
          const context = { companion: dependencies.bot?.username ?? 'Companion', owner,
            skills: dependencies.library.list().map(s => ({ name: s.name, description: s.description, ...skillOrigin(s, dependencies.ownerUuid) })),
            // T29 A5: the agent cannot invoke primitives, so the full schema is
            // dead weight — name and description are enough context.
            primitives: dependencies.registry.list().filter(n => n !== 'say')
              .map(n => ({ name: n, description: dependencies.registry.describe(n).description })),
            recent: recent.slice(-6), task: dependencies.arbiter.current?.() ?? null,
            ...(recovery ? { recovery: { status: recovery.status, reason: recovery.reason, steps: recovery.steps },
              observation: lookAround(dependencies.bot, dependencies.ownerUuid) } : {}) };
          context.obtaining = tools.some(t => t.name === 'obtain') ? '有 obtain 工具可通过规划和执行获得物品。规划失败返回 needs_smelting 等原因时，如实说明无法完成，不要承诺。' : null;
          pi.bridge.setRun({ tools, signal: controller.signal,
            systemPrompt: `${buildPersona(owner)}\n只能通过工具做事。只描述已经发生或正在发生的事实，不许诺工具和技能做不到的事。说话简短。只有 list_skills 里 origin 为 taught 的技能才可以说成是玩家教的；内置技能不许说成是谁教的。\n${JSON.stringify(context)}` });
          const accepted = await Promise.race([pi.command('prompt', { message }), settled.then(() => null)]);
          if (accepted?.disposition === 'handled') finish();
          await settled;
        }
        if (reason === 'timeout') { log('agent.fallback', { reason }, traceId); return { text: null, timeout: true }; }
        if (reason === 'cancelled' || last?.stopReason === 'aborted') return { text: null, cancelled: true };
        if (reason === 'tool_limit' || reason === 'quota') return { text: null };
        if (reason) { if (reason !== 'tools_mismatch') log('agent.fallback', { reason }, traceId); return { fallback: true }; }
        const text = last?.content?.filter(c => c.type === 'text').map(c => c.text).join('') || null;
        if (!allowsProvenanceClaim(text, dependencies.library.list())) {
          log('agent.fallback', { reason: 'provenance_claim' }, traceId);
          return { fallback: true };
        }
        return { text };
      } catch { if (!reason) log('agent.fallback', { reason: 'request_failed' }, traceId); return { fallback: true }; }
      finally {
        if (aborting) {
          let grace;
          await Promise.race([aborting, new Promise(resolve => { grace = setTimeout(() => { void pi.close(); resolve(); }, 1000); })]);
          clearTimeout(grace);
        }
        clearTimeout(timer); controller.abort(); pi.bridge.setRun(null); active = null;
        pi.events.off('event', onEvent); pi.events.off('exit', onExit); pi.events.off('report', onReport);
        pi.bridge.events.off('tool_result', onResult);
      }
    } };
}
