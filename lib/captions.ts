import type { CaptionTrack, Cue, VideoInfo } from './types';
import { languageGroup } from './languages';

/** Bump when segmentation changes so cached translations keyed by cue id are not reused. */
export const SEGMENTER_VERSION = 2;

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
  aAppend?: number;
}
interface Json3 {
  events?: Json3Event[];
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parseJson3(raw: string, isAsr: boolean): Cue[] {
  const data = JSON.parse(raw) as Json3;
  const events = (data.events ?? []).filter((e) => e.segs?.length);
  return isAsr ? segmentAsr(events) : manualCues(events);
}

function manualCues(events: Json3Event[]): Cue[] {
  const cues: Cue[] = [];
  for (const e of events) {
    const text = clean((e.segs ?? []).map((s) => s.utf8 ?? '').join(''));
    if (!text) continue;
    const start = e.tStartMs ?? 0;
    const end = start + (e.dDurationMs ?? 0);
    const prev = cues.at(-1);
    // Some tracks repeat the previous line as a rolling caption; collapse exact repeats.
    if (prev && prev.text === text && start - prev.end < 100) {
      prev.end = Math.max(prev.end, end);
      continue;
    }
    cues.push({ id: cues.length, start, end, text });
  }
  return cues;
}

interface Word {
  start: number;
  end: number;
  text: string;
}

const SENTENCE_END = /[.!?。！？…]["')\]」』]?$/;
const CLAUSE_END = /[,;:，；：、]$/;
const MAX_CUE_MS = 6500;

/**
 * Auto-generated captions arrive as a rolling stream of timed words. Re-group
 * them into sentence-like cues using punctuation, pauses and length limits so
 * they read (and translate) as natural subtitle lines.
 */
function segmentAsr(events: Json3Event[]): Cue[] {
  const words: Word[] = [];
  let spacedSegs = 0;
  let totalSegs = 0;
  for (const e of events) {
    if (e.aAppend) continue;
    const base = e.tStartMs ?? 0;
    const evEnd = base + (e.dDurationMs ?? 0);
    const segs = e.segs ?? [];
    segs.forEach((s, i) => {
      const raw = s.utf8 ?? '';
      const text = raw.trim();
      if (!text) return;
      totalSegs++;
      if (/^\s/.test(raw)) spacedSegs++;
      const start = base + (s.tOffsetMs ?? 0);
      const next = segs[i + 1];
      const end = next ? base + (next.tOffsetMs ?? 0) : evEnd;
      words.push({ start, end: Math.max(end, start + 1), text });
    });
  }
  // Clamp word ends to the next word start so cue durations do not overlap.
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i]!;
    w.end = Math.max(w.start + 1, Math.min(w.end, words[i + 1]!.start));
  }

  // Space-delimited languages mark word boundaries with a leading space on
  // every seg except the first of each line; CJK captions have none.
  const spaced = spacedSegs > totalSegs * 0.2;
  const sep = spaced ? ' ' : '';
  const maxChars = spaced ? 84 : 32;
  const minChars = spaced ? 12 : 4;

  const cues: Cue[] = [];
  let cur: Word[] = [];
  let len = 0;
  const flush = () => {
    if (!cur.length) return;
    const text = clean(cur.map((w) => w.text).join(sep));
    if (text) cues.push({ id: cues.length, start: cur[0]!.start, end: cur.at(-1)!.end, text });
    cur = [];
    len = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    // Never overflow: start a new cue before adding a word that would not fit.
    if (cur.length && len + sep.length + w.text.length > maxChars) flush();
    cur.push(w);
    len += (cur.length > 1 ? sep.length : 0) + w.text.length;
    if (!next) break;
    // Time from this word to the next one: long values mean the speaker paused.
    const pause = next.start - w.start;
    const duration = next.start - cur[0]!.start;
    if (
      (SENTENCE_END.test(w.text) && len >= minChars) ||
      (CLAUSE_END.test(w.text) && len >= maxChars * 0.5) ||
      pause > 1600 ||
      (pause > 900 && len >= maxChars * 0.4) ||
      duration >= MAX_CUE_MS
    ) {
      flush();
    }
  }
  flush();
  return cues;
}

/** Pick the most useful source track: the original-language human track, else ASR. */
export function chooseTrack(info: VideoInfo): number {
  const { tracks } = info;
  if (!tracks.length) return -1;
  const asr = tracks.find((t) => t.kind === 'asr');
  if (asr) {
    const manualSameLang = tracks.findIndex(
      (t) => t.kind !== 'asr' && languageGroup(t.languageCode) === languageGroup(asr.languageCode),
    );
    if (manualSameLang >= 0) return manualSameLang;
  }
  if (info.defaultTrackIndex != null && tracks[info.defaultTrackIndex]) return info.defaultTrackIndex;
  const manual = tracks.findIndex((t) => t.kind !== 'asr');
  return manual >= 0 ? manual : 0;
}

export function trackKey(t: CaptionTrack): string {
  return `${t.languageCode}:${t.kind ?? 'std'}:${t.vssId}`;
}

/** Index of the last cue that has started at `timeMs`, or -1. */
export function findCueIndex(cues: Cue[], timeMs: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= timeMs) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Spread-out sample of the transcript, capped at `limit` characters. */
export function sampleTranscript(cues: Cue[], limit = 12000): string {
  const full = cues.map((c) => c.text).join(' ');
  if (full.length <= limit) return full;
  const parts = 4;
  const size = Math.floor(limit / parts);
  const out: string[] = [];
  for (let i = 0; i < parts; i++) {
    const at = Math.floor(((full.length - size) * i) / (parts - 1));
    out.push(full.slice(at, at + size));
  }
  return out.join(' […] ');
}
