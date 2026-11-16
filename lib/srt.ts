import type { Cue, DisplayMode } from './types';

function srtTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = Math.floor(ms % 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(f, 3)}`;
}

export function buildSrt(
  cues: Cue[],
  translations: (string | undefined)[],
  mode: DisplayMode,
  translationFirst: boolean,
): string {
  const blocks: string[] = [];
  cues.forEach((c, i) => {
    const tr = translations[c.id];
    let lines: string[];
    if (mode === 'source') lines = [c.text];
    else if (mode === 'target') lines = [tr ?? c.text];
    else lines = tr ? (translationFirst ? [tr, c.text] : [c.text, tr]) : [c.text];
    // Never let a cue end after the next one starts, players stack them otherwise.
    const next = cues[i + 1];
    const end = next ? Math.min(c.end, next.start) : c.end;
    blocks.push(`${i + 1}\n${srtTime(c.start)} --> ${srtTime(Math.max(end, c.start + 300))}\n${lines.join('\n')}`);
  });
  return blocks.join('\n\n') + '\n';
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-subrip;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[\\/:*?"<>|]+/g, ' ').trim();
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
