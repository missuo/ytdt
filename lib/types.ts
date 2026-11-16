/** A single subtitle cue. Times are in milliseconds. `id` equals its index in the cue array. */
export interface Cue {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  /** `asr` for YouTube's auto-generated (speech recognition) captions. */
  kind?: string;
  vssId: string;
}

export interface VideoInfo {
  videoId: string;
  title: string;
  description: string;
  author: string;
  tracks: CaptionTrack[];
  defaultTrackIndex: number | null;
}

export type DisplayMode = 'bilingual' | 'source' | 'target';

export interface GlossaryEntry {
  term: string;
  translation: string;
}

export interface VideoSummary {
  summary: string;
  glossary: GlossaryEntry[];
}

export interface ContextLine {
  id: number;
  text: string;
  translation?: string;
}

/** One unit of work sent from the content script to the background worker. */
export interface TranslateJob {
  targetLang: string;
  title: string;
  summary: VideoSummary | null;
  previous: ContextLine[];
  lines: ContextLine[];
  following: ContextLine[];
}

export interface SummaryJob {
  targetLang: string;
  title: string;
  description: string;
  transcript: string;
}
