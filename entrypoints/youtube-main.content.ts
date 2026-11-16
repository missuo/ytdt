/**
 * Runs in the page's MAIN world so it can read the YouTube player.
 *
 * YouTube's timedtext endpoint only answers requests that carry a
 * proof-of-origin token (`pot`) minted by the player. We never patch page
 * APIs (that trips YouTube's integrity checks); instead a PerformanceObserver
 * notices the player's own timedtext requests, and we reuse their token to
 * fetch the track we want in json3.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { BRIDGE_TAG, type BridgeRequest, type BridgeResponse } from '@/lib/bridge';
import type { CaptionTrack, VideoInfo } from '@/lib/types';

export default defineContentScript({
  matches: ['*://www.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installPageAgent();
  },
});

interface YtPlayer extends HTMLElement {
  getPlayerResponse?: () => any;
}

/** Params that describe the track rather than the player's auth context. */
const TRACK_PARAMS = new Set(['v', 'lang', 'kind', 'name', 'tlang', 'fmt']);

function installPageAgent() {
  /** Latest player-issued timedtext URL per video, carrying the `pot` token. */
  const authUrls = new Map<string, URL>();
  /** json3 bodies keyed by `${videoId}|${lang}|${kind}`. */
  const bodies = new Map<string, string>();
  const listeners = new Set<() => void>();

  const keyOf = (v: string, t: CaptionTrack) => `${v}|${t.languageCode}|${t.kind ?? ''}`;

  function noteUrl(name: string) {
    if (!name.includes('/api/timedtext')) return;
    let u: URL;
    try {
      u = new URL(name, location.href);
    } catch {
      return;
    }
    const v = u.searchParams.get('v');
    if (!v || !u.searchParams.has('pot')) return;
    authUrls.set(v, u);
    listeners.forEach((l) => l());
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) noteUrl(e.name);
    }).observe({ type: 'resource', buffered: true });
  } catch {
    /* PerformanceObserver unavailable: fall back to plain requests only */
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const player = () => document.getElementById('movie_player') as YtPlayer | null;

  function readPlayerResponse(): any {
    try {
      const r = player()?.getPlayerResponse?.();
      if (r) return r;
    } catch {
      /* ignore */
    }
    return (window as any).ytInitialPlayerResponse;
  }

  function textOf(v: any): string {
    if (!v) return '';
    if (typeof v.simpleText === 'string') return v.simpleText;
    if (Array.isArray(v.runs)) return v.runs.map((r: any) => r.text ?? '').join('');
    return '';
  }

  function toVideoInfo(r: any): VideoInfo {
    const renderer = r?.captions?.playerCaptionsTracklistRenderer;
    const tracks: CaptionTrack[] = (renderer?.captionTracks ?? []).map((t: any) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      name: textOf(t.name) || t.languageCode,
      kind: t.kind,
      vssId: t.vssId ?? '',
    }));
    const audio = renderer?.audioTracks?.[renderer?.defaultAudioTrackIndex ?? 0];
    const def = audio?.defaultCaptionTrackIndex;
    return {
      videoId: r.videoDetails?.videoId ?? '',
      title: r.videoDetails?.title ?? document.title,
      description: r.videoDetails?.shortDescription ?? '',
      author: r.videoDetails?.author ?? '',
      tracks,
      defaultTrackIndex: typeof def === 'number' ? def : null,
    };
  }

  function isJson3(text: string): boolean {
    if (text.trimStart()[0] !== '{') return false;
    try {
      return Array.isArray(JSON.parse(text).events);
    } catch {
      return false;
    }
  }

  async function tryFetch(url: URL): Promise<string | null> {
    try {
      const res = await fetch(url.href, { credentials: 'include' });
      if (!res.ok) return null;
      const text = await res.text();
      return isJson3(text) ? text : null;
    } catch {
      return null;
    }
  }

  /** The track's own URL, plus the player's auth params when we have them. */
  function trackUrl(track: CaptionTrack, auth?: URL): URL {
    const u = new URL(track.baseUrl, location.origin);
    u.searchParams.set('fmt', 'json3');
    u.searchParams.delete('tlang');
    if (auth) {
      for (const [k, val] of auth.searchParams) {
        if (!TRACK_PARAMS.has(k) && !u.searchParams.has(k)) u.searchParams.set(k, val);
      }
      for (const k of ['pot', 'c', 'cver']) {
        const val = auth.searchParams.get(k);
        if (val) u.searchParams.set(k, val);
      }
    }
    return u;
  }

  function waitForAuth(videoId: string, timeoutMs: number): Promise<URL | undefined> {
    return new Promise((resolve) => {
      const check = () => {
        const u = authUrls.get(videoId);
        if (u) finish(u);
      };
      const finish = (u: URL | undefined) => {
        listeners.delete(check);
        clearTimeout(timer);
        resolve(u);
      };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      listeners.add(check);
      check();
    });
  }

  /**
   * Turn the player's captions on for a moment so it issues an authenticated
   * timedtext request, then put the toggle back the way the user had it.
   */
  async function nudgePlayer(videoId: string): Promise<URL | undefined> {
    const button = document.querySelector<HTMLButtonElement>('#movie_player .ytp-subtitles-button');
    if (!button || button.getAttribute('aria-pressed') === 'true') {
      return waitForAuth(videoId, 8000);
    }
    button.click();
    try {
      return await waitForAuth(videoId, 10000);
    } finally {
      await sleep(300);
      if (button.getAttribute('aria-pressed') === 'true') button.click();
    }
  }

  // --- Request handlers -------------------------------------------------------
  async function getVideoInfo({ videoId }: { videoId: string }): Promise<VideoInfo> {
    for (let i = 0; i < 80; i++) {
      const r = readPlayerResponse();
      if (r?.videoDetails?.videoId === videoId) return toVideoInfo(r);
      await sleep(250);
    }
    throw new Error('YouTube player data is not available for this video.');
  }

  async function fetchTrack({ videoId, track }: { videoId: string; track: CaptionTrack }): Promise<string> {
    const key = keyOf(videoId, track);
    const hit = bodies.get(key);
    if (hit) return hit;

    let text: string | null = null;
    const known = authUrls.get(videoId) ?? (await waitForAuth(videoId, 1500));
    if (known) text = await tryFetch(trackUrl(track, known));
    // Some videos still serve captions without a token.
    text ??= await tryFetch(trackUrl(track));
    if (!text) {
      const auth = await nudgePlayer(videoId);
      if (auth) text = await tryFetch(trackUrl(track, auth));
    }
    if (!text) throw new Error('Could not load captions from YouTube. Try turning captions (CC) on once.');
    bodies.set(key, text);
    return text;
  }

  const handlers: Record<string, (params: any) => Promise<unknown>> = { getVideoInfo, fetchTrack };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data as BridgeRequest | undefined;
    if (!data || data[BRIDGE_TAG] !== 'req') return;
    const reply: BridgeResponse = { [BRIDGE_TAG]: 'res', id: data.id };
    try {
      const handler = handlers[data.method];
      if (!handler) throw new Error(`Unknown method ${data.method}`);
      reply.result = await handler(data.params);
    } catch (e) {
      reply.error = e instanceof Error ? e.message : String(e);
    }
    window.postMessage(reply, location.origin);
  });
}
