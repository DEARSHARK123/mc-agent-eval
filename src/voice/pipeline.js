import { voiceStyle } from './style.js';

export function createVoice({ tts, player, eventlog }) {
  let queue = Promise.resolve();
  let controller = new AbortController();
  let closed = false;
  return {
    say(text, traceId, { kind } = {}) {
      const signal = controller.signal;
      const result = queue.then(async () => {
        if (closed || signal.aborted) return;
        const audio = await tts.synthesize(text, { style: voiceStyle(kind), traceId, signal });
        if (!closed && !signal.aborted && audio.pcm) await player.play(audio.pcm, audio.sampleRate, { traceId });
      }).catch(() => { eventlog?.append('voice.error', { reason: 'pipeline' }, traceId); });
      queue = result;
      return result;
    },
    interrupt() {
      controller.abort();
      controller = new AbortController();
      // A cancelled provider must not hold up new utterances even if it ignores abort.
      queue = Promise.resolve();
      return player.interrupt();
    },
    close() {
      closed = true;
      controller.abort();
      return player.close();
    },
  };
}
