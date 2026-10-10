export function skinCommand(url, variant = 'classic') {
  if (typeof url !== 'string' || /[\s"'\u0000-\u001f\u007f]/.test(url) || !['classic', 'slim'].includes(variant)) return null;
  try { if (new URL(url).protocol !== 'https:') return null; } catch { return null; }
  return `skin set "${url}" Companion ${variant}`;
}
