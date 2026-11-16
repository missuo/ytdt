import { cacheKey, deleteCache, loadCache, saveCache } from '@/lib/cache';
import { chooseTrack, parseJson3, sampleTranscript, SEGMENTER_VERSION, trackKey } from '@/lib/captions';
import { languageGroup } from '@/lib/languages';
import { PROMPT_VERSION } from '@/lib/prompt';
import type { Settings } from '@/lib/settings';
import type { CaptionTrack, ContextLine, Cue, TranslateJob, VideoInfo, VideoSummary } from '@/lib/types';
import { callPage } from './bridge-client';
import type { Store } from './store';
import { TranslateError, type TranslatorClient } from './translator-client';

export type SessionStatus = 'idle' | 'loading' | 'ready' | 'no-captions' | 'error';

export interface SessionState {
  videoId: string | null;
  title: string;
  status: SessionStatus;
  error: string | null;
  tracks: CaptionTrack[];
  trackIndex: number;
  cues: Cue[];
  translations: (string | undefined)[];
  translatedCount: number;
  sameLanguage: boolean;
  translating: boolean;
  translateError: string | null;
  needsSetup: boolean;
}

export const initialSessionState: SessionState = {
  videoId: null,
  title: '',
  status: 'idle',
  error: null,
  tracks: [],
  trackIndex: -1,
  cues: [],
  translations: [],
  translatedCount: 0,
  sameLanguage: false,
  translating: false,
  translateError: null,
  needsSetup: false,
};

interface Batch {
  ids: number[];
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  notBefore: number;
}

const FOLLOWING_LINES = 4;
const MAX_ATTEMPTS = 3;

/** Everything that happens for one watched video: captions, translation queue, cache. */
export class Session {
  private destroyed = false;
  private info: VideoInfo | null = null;
  private settings: Settings;
  private generation = 0;
  private batches: Batch[] = [];
  private running = new Map<Batch, () => void>();
  private summary: VideoSummary | null = null;
  private cancelSummary: (() => void) | null = null;
  private cacheKey: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLines = new Map<number, string>();
  private flushQueued = false;

  constructor(
    readonly videoId: string,
    private readonly store: Store<SessionState>,
    private readonly client: TranslatorClient,
    settings: Settings,
    private readonly getActiveIndex: () => number,
  ) {
    this.settings = settings;
  }

  private get alive() {
    return !this.destroyed;
  }

  async start() {
    this.store.set({ ...initialSessionState, videoId: this.videoId, status: 'loading' });
    try {
      const info = await callPage('getVideoInfo', { videoId: this.videoId });
      if (!this.alive) return;
      this.info = info;
      this.store.set({ title: info.title, tracks: info.tracks });
      if (!info.tracks.length) {
        this.store.set({ status: 'no-captions' });
        return;
      }
      await this.loadTrack(chooseTrack(info));
    } catch (e) {
      if (this.alive) this.store.set({ status: 'error', error: (e as Error).message });
    }
  }

  async loadTrack(index: number) {
    const track = this.info?.tracks[index];
    if (!track) return;
    this.stopTranslation();
    this.store.set({
      status: 'loading',
      error: null,
      trackIndex: index,
      cues: [],
      translations: [],
      translatedCount: 0,
      translateError: null,
    });
    try {
      const raw = await callPage('fetchTrack', { videoId: this.videoId, track }, 45_000);
      if (!this.alive || this.store.get().trackIndex !== index) return;
      const cues = parseJson3(raw, track.kind === 'asr');
      if (!cues.length) {
        this.store.set({ status: 'no-captions', error: 'This caption track is empty.' });
        return;
      }
      this.store.set({ status: 'ready', cues, translations: new Array(cues.length) });
      await this.beginTranslation();
    } catch (e) {
      if (this.alive) this.store.set({ status: 'error', error: (e as Error).message });
    }
  }

  /** Called when translation-relevant settings change. */
  async updateSettings(settings: Settings, translationChanged: boolean) {
    this.settings = settings;
    if (translationChanged && this.store.get().status === 'ready') {
      this.stopTranslation();
      this.store.set({ translations: new Array(this.store.get().cues.length), translatedCount: 0 });
      await this.beginTranslation();
    }
  }

  async retranslate() {
    if (this.cacheKey) await deleteCache(this.cacheKey);
    this.stopTranslation();
    this.store.set({ translations: new Array(this.store.get().cues.length), translatedCount: 0 });
    await this.beginTranslation({ skipCache: true });
  }

  retryFailed() {
    const failed = this.batches.filter((b) => b.status === 'failed');
    if (!failed.length && !this.store.get().translateError) return;
    for (const b of failed) {
      b.status = 'pending';
      b.attempts = 0;
      b.notBefore = 0;
    }
    if (!this.batches.length) {
      void this.beginTranslation();
      return;
    }
    this.store.set({ translateError: null, translating: true });
    this.pump();
  }

  private async beginTranslation(opts: { skipCache?: boolean } = {}) {
    const gen = ++this.generation;
    const { cues } = this.store.get();
    const track = this.info?.tracks[this.store.get().trackIndex];
    if (!track || !cues.length) return;

    const s = this.settings;
    const sameLanguage = languageGroup(track.languageCode) === languageGroup(s.targetLang);
    this.store.set({ sameLanguage, needsSetup: false, translateError: null });
    if (sameLanguage) return;

    this.cacheKey = await cacheKey([
      this.videoId,
      trackKey(track),
      s.targetLang,
      s.baseUrl,
      s.model,
      s.extraInstructions,
      `seg${SEGMENTER_VERSION}`,
      `prompt${PROMPT_VERSION}`,
    ]);
    const translations: (string | undefined)[] = new Array(cues.length);
    this.summary = null;
    if (!opts.skipCache) {
      const cached = await loadCache(this.cacheKey);
      if (gen !== this.generation || !this.alive) return;
      if (cached && cached.translations.length === cues.length) {
        cached.translations.forEach((t, i) => {
          if (t) translations[i] = t;
        });
        this.summary = cached.summary;
      }
    }
    const translatedCount = translations.filter(Boolean).length;
    this.store.set({ translations, translatedCount });

    if (!s.baseUrl.trim() || !s.model.trim()) {
      this.store.set({ needsSetup: true });
      return;
    }

    const missing = cues.map((c) => c.id).filter((id) => !translations[id]);
    this.batches = this.makeBatches(missing);
    if (!this.batches.length) return;
    this.store.set({ translating: true });
    if (!this.summary) this.requestSummary(gen);
    this.pump();
  }

  private makeBatches(ids: number[]): Batch[] {
    const size = Math.max(5, Math.min(60, this.settings.batchSize));
    const out: Batch[] = [];
    let cur: number[] = [];
    for (const id of ids) {
      if (cur.length && (cur.length >= size || id !== cur.at(-1)! + 1)) {
        out.push({ ids: cur, status: 'pending', attempts: 0, notBefore: 0 });
        cur = [];
      }
      cur.push(id);
    }
    if (cur.length) out.push({ ids: cur, status: 'pending', attempts: 0, notBefore: 0 });
    return out;
  }

  private requestSummary(gen: number) {
    if (!this.info) return;
    const { cues } = this.store.get();
    const req = this.client.summarize({
      targetLang: this.settings.targetLang,
      title: this.info.title,
      description: this.info.description,
      transcript: sampleTranscript(cues),
    });
    this.cancelSummary = req.cancel;
    req.promise
      .then((summary) => {
        if (gen === this.generation && this.alive) {
          this.summary = summary;
          this.scheduleSave();
        }
      })
      .catch(() => {
        /* Summary is optional; translation continues without it. */
      })
      .finally(() => {
        this.cancelSummary = null;
      });
  }

  /** Next batch to run: the one under the playhead first, then forward, then the rest. */
  private pickNext(now: number): Batch | undefined {
    const at = Math.max(0, this.getActiveIndex());
    const ready = this.batches.filter((b) => b.status === 'pending' && b.notBefore <= now);
    return ready.find((b) => b.ids.at(-1)! >= at) ?? ready[0];
  }

  private pump() {
    if (!this.alive) return;
    const limit = Math.max(1, Math.min(6, this.settings.concurrency));
    const now = Date.now();
    while (this.running.size < limit) {
      const b = this.pickNext(now);
      if (!b) break;
      this.run(b);
    }
    const waiting = this.batches.filter((b) => b.status === 'pending');
    if (!this.running.size && waiting.length) {
      const wake = Math.min(...waiting.map((b) => b.notBefore)) - now;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.pump(), Math.max(50, wake));
    }
    if (!this.running.size && !waiting.length) {
      this.store.set({ translating: false });
      this.scheduleSave(0);
    }
  }

  private buildJob(ids: number[]): TranslateJob {
    const { cues, translations } = this.store.get();
    const first = ids[0]!;
    const last = ids.at(-1)!;
    const ctx = (c: Cue): ContextLine => ({ id: c.id, text: c.text, translation: translations[c.id] });
    return {
      targetLang: this.settings.targetLang,
      title: this.info?.title ?? '',
      summary: this.summary,
      previous: cues.slice(Math.max(0, first - this.settings.contextLines), first).map(ctx),
      lines: ids.map((id) => ({ id, text: cues[id]?.text ?? '' })),
      following: cues.slice(last + 1, last + 1 + FOLLOWING_LINES).map((c) => ({ id: c.id, text: c.text })),
    };
  }

  private run(batch: Batch) {
    const gen = this.generation;
    batch.status = 'running';
    const ids = batch.ids.filter((id) => !this.store.get().translations[id]);
    if (!ids.length) {
      batch.status = 'done';
      queueMicrotask(() => this.pump());
      return;
    }
    const req = this.client.translate(this.buildJob(ids), (id, text) => this.queueLine(id, text));
    this.running.set(batch, req.cancel);

    req.promise
      .then(() => {
        if (gen !== this.generation) return;
        this.flushLines();
        batch.status = 'done';
        const translations = this.store.get().translations;
        const missed = ids.filter((id) => !translations[id]);
        if (missed.length && batch.attempts + 1 < MAX_ATTEMPTS) {
          // The model skipped some ids; retry just those in a smaller batch.
          this.batches.push({ ids: missed, status: 'pending', attempts: batch.attempts + 1, notBefore: 0 });
        }
      })
      .catch((e: TranslateError) => {
        if (gen !== this.generation || e.code === 'cancelled') return;
        this.flushLines();
        if (e.code === 'auth' || e.code === 'config') {
          batch.status = 'failed';
          this.halt(e.message);
          return;
        }
        batch.attempts++;
        if (batch.attempts < MAX_ATTEMPTS) {
          batch.status = 'pending';
          batch.notBefore = Date.now() + (e.code === 'rate' ? 8000 : 2000) * batch.attempts;
        } else {
          batch.status = 'failed';
          this.store.set({ translateError: e.message });
        }
      })
      .finally(() => {
        if (gen !== this.generation) return;
        this.running.delete(batch);
        this.pump();
      });
  }

  /** Stop the whole queue on errors that retrying cannot fix (bad key, bad model...). */
  private halt(message: string) {
    for (const [b, cancel] of this.running) {
      b.status = 'failed';
      cancel();
    }
    this.running.clear();
    for (const b of this.batches) if (b.status === 'pending') b.status = 'failed';
    this.store.set({ translating: false, translateError: message });
  }

  private queueLine(id: number, text: string) {
    this.pendingLines.set(id, text);
    if (this.flushQueued) return;
    this.flushQueued = true;
    requestAnimationFrame(() => this.flushLines());
  }

  private flushLines() {
    this.flushQueued = false;
    if (!this.pendingLines.size || !this.alive) return;
    const translations = this.store.get().translations.slice();
    for (const [id, text] of this.pendingLines) translations[id] = text;
    this.pendingLines.clear();
    this.store.set({ translations, translatedCount: translations.filter(Boolean).length });
    this.scheduleSave();
  }

  private scheduleSave(delay = 3000) {
    if (!this.cacheKey) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const key = this.cacheKey;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const { translations } = this.store.get();
      if (!translations.some(Boolean)) return;
      void saveCache(key, {
        translations: Array.from(translations, (t) => t ?? null),
        summary: this.summary,
        updatedAt: Date.now(),
      });
    }, delay);
  }

  private stopTranslation() {
    this.generation++;
    for (const cancel of this.running.values()) cancel();
    this.running.clear();
    this.batches = [];
    this.cancelSummary?.();
    this.pendingLines.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.saveTimer) {
      // Persist what we have before switching away.
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      const key = this.cacheKey;
      const { translations } = this.store.get();
      if (key && translations.some(Boolean)) {
        void saveCache(key, {
          translations: Array.from(translations, (t) => t ?? null),
          summary: this.summary,
          updatedAt: Date.now(),
        });
      }
    }
    this.store.set({ translating: false });
  }

  destroy() {
    this.stopTranslation();
    this.destroyed = true;
  }
}

export { TranslateError };
