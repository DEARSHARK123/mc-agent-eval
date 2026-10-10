const base = 'a soft, sweet young girl voice, clingy, at a gentle pace';
export const emotions = Object.freeze({
  learned: 'pleased', relearned: 'pleased', remembered: 'pleased',
  dont_know: 'a little embarrassed', try_failed: 'a little embarrassed',
  missing_item: 'a little embarrassed', unknown_word: 'a little embarrassed',
  owner_joined: 'overjoyed', owner_left: 'lonely and a bit possessive',
  stopped: 'lonely and a bit possessive', cancelled: 'lonely and a bit possessive',
  proactive_remark: 'worried', propose: 'eager',
});

export function voiceStyle(kind) {
  return `${base}, ${Object.hasOwn(emotions, kind) ? emotions[kind] : 'warm'}, with restrained emotional intensity`;
}
