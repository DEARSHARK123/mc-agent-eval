import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createFish } from '../src/voice/fish.js';
import { pcmToWav } from '../src/voice/player.js';
import { removePathRobust } from '../src/fsutil.js';

const dir = fileURLToPath(new URL('../.tmp/tts-smoke/', import.meta.url));
try {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('Missing TTS credential');
  let metrics;
  const fish = createFish({ apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.TTS_FISH_MODEL || undefined, voice: process.env.TTS_FISH_VOICE || '',
    eventlog: { append(kind, payload) { if (kind === 'voice.synth') metrics = payload; } } });
  const audio = await fish.synthesizeOnce({ text: '今天的阳光很温暖。' });
  if (!audio.pcm) throw new Error('Synthesis failed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sample.wav'), pcmToWav(audio.pcm, audio.sampleRate));
  console.log(JSON.stringify({ provider: 'fish', sampleRate: audio.sampleRate, bytes: audio.pcm.length,
    durationSeconds: audio.pcm.length / 2 / audio.sampleRate,
    firstChunkMs: metrics.firstChunkMs, totalMs: metrics.totalMs }));
} catch { console.error('TTS smoke failed'); process.exitCode = 1; }
finally { if (!removePathRobust(dir)) { console.error('TTS smoke cleanup failed'); process.exitCode = 1; } }
