import { createRoot, type Root } from 'react-dom/client';
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { findCueIndex } from '@/lib/captions';
import type { RuntimeRequest } from '@/lib/messages';
import { buildSrt, downloadText } from '@/lib/srt';
import { translationFingerprint, updateSettings, watchSettings, type Settings } from '@/lib/settings';
import type { DisplayMode } from '@/lib/types';
import { Overlay } from './Overlay';
import { Panel, type PanelActions } from './Panel';
import { initialSessionState, Session, type SessionState } from './session';
import { createStore, type Store } from './store';
import { TranslatorClient } from './translator-client';
import overlayCss from './overlay.css?inline';
import panelCss from './panel.css?inline';

export interface PlaybackState {
  activeIndex: number;
  /** Whether the active cue is on screen right now (not in a gap or an ad). */
  visible: boolean;
}

const PAGE_CSS = `
html.ytdt-hide-native .ytp-caption-window-container { display: none !important; }
`;

function videoIdFromUrl(): string | null {
  const u = new URL(location.href);
  if (u.pathname === '/watch') return u.searchParams.get('v');
  const live = /^\/live\/([\w-]{6,})/.exec(u.pathname);
  return live?.[1] ?? null;
}

class ShadowMount {
  readonly host: HTMLDivElement;
  private root: Root | null = null;

  constructor(id: string, css: string, private readonly render: () => React.ReactNode) {
    this.host = document.createElement('div');
    this.host.id = id;
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    const mountPoint = document.createElement('div');
    shadow.append(style, mountPoint);
    this.root = createRoot(mountPoint);
    this.root.render(this.render());
  }

  /** Make sure the host lives where it should; YouTube re-renders its layout freely. */
  ensure(parent: Element | null, position: 'first' | 'last') {
    if (!parent) {
      this.host.remove();
      return;
    }
    if (this.host.parentElement === parent) return;
    if (position === 'first') parent.prepend(this.host);
    else parent.append(this.host);
  }

  detach() {
    this.host.remove();
  }

  destroy() {
    this.root?.unmount();
    this.root = null;
    this.host.remove();
  }
}

export class App {
  readonly settings: Store<Settings>;
  readonly session = createStore<SessionState>(initialSessionState);
  readonly playback = createStore<PlaybackState>({ activeIndex: -1, visible: false });
  private readonly client = new TranslatorClient();
  private current: Session | null = null;
  private video: HTMLVideoElement | null = null;
  private raf = 0;
  private panel: ShadowMount | null = null;
  private overlay: ShadowMount | null = null;
  private playerObserver: ResizeObserver | null = null;
  private classObserver: MutationObserver | null = null;
  private observedPlayer: Element | null = null;
  private lastUrl = '';

  constructor(
    private readonly ctx: ContentScriptContext,
    settings: Settings,
  ) {
    this.settings = createStore(settings);
  }

  start() {
    const style = document.createElement('style');
    style.id = 'ytdt-page-style';
    style.textContent = PAGE_CSS;
    document.head.append(style);

    const actions: PanelActions = {
      seek: (ms) => this.seek(ms),
      setMode: (mode: DisplayMode) => void updateSettings({ displayMode: mode }),
      selectTrack: (i) => void this.current?.loadTrack(i),
      retry: () => this.current?.retryFailed(),
      retranslate: () => void this.current?.retranslate(),
      reload: () => this.navigate(true),
      openOptions: () => void browser.runtime.sendMessage({ type: 'openOptions' } satisfies RuntimeRequest),
      download: (mode) => this.download(mode),
    };

    this.panel = new ShadowMount('ytdt-panel-host', panelCss, () => (
      <Panel session={this.session} playback={this.playback} settings={this.settings} actions={actions} />
    ));
    this.overlay = new ShadowMount('ytdt-overlay-host', overlayCss, () => (
      <Overlay session={this.session} playback={this.playback} settings={this.settings} />
    ));

    const unwatch = watchSettings((next) => this.onSettings(next));
    const unsubSession = this.session.subscribe(() => this.syncPage());
    const unsubSettings = this.settings.subscribe(() => this.syncPage());

    this.ctx.addEventListener(document, 'yt-navigate-finish' as any, () => this.navigate());
    this.ctx.setInterval(() => this.tick(), 1000);
    this.navigate();

    this.ctx.onInvalidated(() => {
      unwatch();
      unsubSession();
      unsubSettings();
      this.current?.destroy();
      this.client.dispose();
      this.panel?.destroy();
      this.overlay?.destroy();
      this.playerObserver?.disconnect();
      this.classObserver?.disconnect();
      cancelAnimationFrame(this.raf);
      style.remove();
      document.documentElement.classList.remove('ytdt-hide-native');
    });
  }

  private onSettings(next: Settings) {
    const prev = this.settings.get();
    this.settings.set(next);
    if (prev.enabled !== next.enabled) {
      this.navigate(true);
      return;
    }
    const changed =
      translationFingerprint(prev) !== translationFingerprint(next) ||
      prev.batchSize !== next.batchSize ||
      prev.contextLines !== next.contextLines;
    void this.current?.updateSettings(next, changed);
  }

  /** Start or tear down the session to match the current URL. */
  private navigate(force = false) {
    const id = this.settings.get().enabled ? videoIdFromUrl() : null;
    this.lastUrl = location.href;
    if (!force && id && this.current?.videoId === id) return;
    this.current?.destroy();
    this.current = null;
    this.playback.set({ activeIndex: -1, visible: false });
    if (!id) {
      this.session.set(initialSessionState);
      this.panel?.detach();
      this.overlay?.detach();
      return;
    }
    this.current = new Session(id, this.session, this.client, this.settings.get(), () =>
      this.playback.get().activeIndex,
    );
    void this.current.start();
    this.tick();
  }

  /** Periodic housekeeping: SPA URL changes, re-mounting, video element swaps. */
  private tick() {
    if (location.href !== this.lastUrl) this.navigate();
    if (!this.current) return;
    const s = this.settings.get();

    const secondary = document.querySelector('#secondary-inner') ?? document.querySelector('#secondary');
    if (s.showPanel) this.panel?.ensure(secondary, 'first');
    else this.panel?.detach();
    // YouTube marks dark theme with <html dark>; mirror it onto the panel host.
    this.panel?.host.toggleAttribute('data-dark', document.documentElement.hasAttribute('dark'));

    const player = document.querySelector('#movie_player');
    this.overlay?.ensure(player, 'last');
    this.observePlayer(player);

    const video = document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video');
    if (video !== this.video) this.attachVideo(video);
  }

  private observePlayer(player: Element | null) {
    if (player === this.observedPlayer) return;
    this.observedPlayer = player;
    this.playerObserver?.disconnect();
    this.classObserver?.disconnect();
    if (!player) return;
    const sync = () => {
      const h = player.getBoundingClientRect().height;
      this.panel?.host.style.setProperty('--ytdt-player-h', `${Math.round(h)}px`);
      this.overlay?.host.style.setProperty('--ytdt-base', `${Math.max(14, Math.min(42, h * 0.036))}px`);
      const controls = !player.classList.contains('ytp-autohide');
      this.overlay?.host.toggleAttribute('data-controls', controls);
      this.updatePlayback();
    };
    this.playerObserver = new ResizeObserver(sync);
    this.playerObserver.observe(player);
    this.classObserver = new MutationObserver(sync);
    this.classObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  private attachVideo(video: HTMLVideoElement | null) {
    this.video = video;
    if (!video) return;
    const loop = () => {
      this.updatePlayback();
      if (this.video === video && !video.paused) this.raf = requestAnimationFrame(loop);
    };
    const kick = () => {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(loop);
    };
    for (const ev of ['play', 'playing', 'seeked', 'timeupdate', 'loadeddata']) {
      this.ctx.addEventListener(video, ev as keyof HTMLVideoElementEventMap, kick);
    }
    kick();
  }

  private updatePlayback() {
    const video = this.video;
    const { cues } = this.session.get();
    if (!video || !cues.length) {
      this.playback.set({ activeIndex: -1, visible: false });
      return;
    }
    const t = video.currentTime * 1000;
    const idx = findCueIndex(cues, t);
    const cue = cues[idx];
    const adShowing = !!this.observedPlayer?.classList.contains('ad-showing');
    const visible = !!cue && !adShowing && t <= Math.max(cue.end, cue.start + 800) + 150;
    this.playback.set({ activeIndex: idx, visible });
  }

  private syncPage() {
    const s = this.settings.get();
    const { status, cues } = this.session.get();
    const hide = s.enabled && s.showOverlay && status === 'ready' && cues.length > 0;
    document.documentElement.classList.toggle('ytdt-hide-native', hide);
    this.updatePlayback();
  }

  private seek(ms: number) {
    const video = this.video;
    if (!video) return;
    video.currentTime = ms / 1000 + 0.01;
    this.updatePlayback();
  }

  private download(mode: DisplayMode) {
    const { cues, translations, title, videoId } = this.session.get();
    if (!cues.length) return;
    const s = this.settings.get();
    const suffix = mode === 'source' ? 'original' : mode === 'target' ? s.targetLang : `${s.targetLang}.dual`;
    downloadText(`${title || videoId}.${suffix}.srt`, buildSrt(cues, translations, mode, s.translationFirst));
  }
}
