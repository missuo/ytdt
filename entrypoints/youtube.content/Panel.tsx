import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatTimestamp } from '@/lib/captions';
import { languageName } from '@/lib/languages';
import type { Settings } from '@/lib/settings';
import type { Cue, DisplayMode } from '@/lib/types';
import { ChevronIcon, DownloadIcon, GearIcon, LocateIcon, RefreshIcon } from './icons';
import type { PlaybackState } from './app';
import type { SessionState } from './session';
import { useStore, type Store } from './store';

export interface PanelActions {
  seek(ms: number): void;
  setMode(mode: DisplayMode): void;
  selectTrack(index: number): void;
  retry(): void;
  retranslate(): void;
  reload(): void;
  openOptions(): void;
  download(mode: DisplayMode): void;
}

interface Props {
  session: Store<SessionState>;
  playback: Store<PlaybackState>;
  settings: Store<Settings>;
  actions: PanelActions;
}

const MODES: { id: DisplayMode; label: string }[] = [
  { id: 'bilingual', label: 'Dual' },
  { id: 'source', label: 'Original' },
  { id: 'target', label: 'Translated' },
];

export function Panel({ session, playback, settings, actions }: Props) {
  const s = useStore(session);
  const cfg = useStore(settings);
  const { activeIndex } = useStore(playback);
  const [collapsed, setCollapsed] = useState(false);
  const [follow, setFollow] = useState(true);
  const [menu, setMenu] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const mode: DisplayMode = s.sameLanguage ? 'source' : cfg.displayMode;

  // Keep the active line in view (about a third from the top) while following.
  useLayoutEffect(() => {
    if (!follow || collapsed || activeIndex < 0) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-id="${activeIndex}"]`);
    if (!list || !row) return;
    const target = row.offsetTop - list.clientHeight * 0.32;
    list.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, [activeIndex, follow, collapsed, s.cues]);

  useEffect(() => setFollow(true), [s.videoId]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const stopFollow = () => setFollow(false);
  const onSeek = useCallback(
    (ms: number) => {
      actions.seek(ms);
      setFollow(true);
    },
    [actions],
  );
  const total = s.cues.length;
  const pct = total ? Math.round((s.translatedCount / total) * 100) : 0;

  return (
    <section className={`panel${collapsed ? ' collapsed' : ''}`}>
      <header className="head">
        <h2>Timeline</h2>
        <div className="tools">
          {!s.sameLanguage && (
            <div className="seg" role="radiogroup" aria-label="Display mode">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  role="radio"
                  aria-checked={cfg.displayMode === m.id}
                  className={cfg.displayMode === m.id ? 'on' : ''}
                  onClick={() => actions.setMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
          <div className="menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button className="icon" title="Download subtitles" disabled={!total} onClick={() => setMenu((v) => !v)}>
              <DownloadIcon />
            </button>
            {menu && (
              <div className="menu" role="menu">
                <button role="menuitem" onClick={() => (actions.download('bilingual'), setMenu(false))}>
                  Dual-language .srt
                </button>
                <button role="menuitem" onClick={() => (actions.download('source'), setMenu(false))}>
                  Original .srt
                </button>
                <button
                  role="menuitem"
                  disabled={!s.translatedCount}
                  onClick={() => (actions.download('target'), setMenu(false))}
                >
                  Translated .srt
                </button>
              </div>
            )}
          </div>
          <button className="icon" title="Settings" onClick={actions.openOptions}>
            <GearIcon />
          </button>
          <button
            className="icon chevron"
            title={collapsed ? 'Expand' : 'Collapse'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
          >
            <ChevronIcon />
          </button>
        </div>
      </header>

      {!collapsed && (
        <>
          <div className="meta">
            {s.tracks.length > 0 && (
              <select
                className="track"
                value={s.trackIndex}
                title="Source caption track"
                onChange={(e) => actions.selectTrack(Number(e.target.value))}
              >
                {s.tracks.map((t, i) => (
                  <option key={t.vssId || i} value={i}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <Status s={s} pct={pct} target={languageName(cfg.targetLang)} actions={actions} />
          </div>
          {s.translating && (
            <div className="progress" aria-hidden>
              <div style={{ width: `${pct}%` }} />
            </div>
          )}

          <Notice s={s} actions={actions} />

          <div
            className="list"
            ref={listRef}
            onWheel={stopFollow}
            onTouchMove={stopFollow}
            onKeyDown={stopFollow}
            tabIndex={-1}
          >
            {s.cues.map((c) => (
              <Row
                key={c.id}
                cue={c}
                translation={s.translations[c.id]}
                state={c.id === activeIndex ? 'active' : c.id < activeIndex ? 'past' : 'future'}
                mode={mode}
                pending={!s.sameLanguage && !s.needsSetup}
                onSeek={onSeek}
              />
            ))}
          </div>
          {!follow && total > 0 && (
            <button className="resync" onClick={() => setFollow(true)}>
              <LocateIcon width={15} height={15} /> Back to current line
            </button>
          )}
        </>
      )}
    </section>
  );
}

function Status({
  s,
  pct,
  target,
  actions,
}: {
  s: SessionState;
  pct: number;
  target: string;
  actions: PanelActions;
}) {
  if (s.status !== 'ready') return null;
  if (s.sameLanguage) return <span className="status">Already in {target}</span>;
  if (s.needsSetup) return null;
  if (s.translating)
    return (
      <span className="status busy">
        Translating · {s.translatedCount}/{s.cues.length} ({pct}%)
      </span>
    );
  return (
    <span className="status">
      {target} · {s.translatedCount}/{s.cues.length}
      <button className="icon tiny" title="Translate again" onClick={actions.retranslate}>
        <RefreshIcon width={14} height={14} />
      </button>
    </span>
  );
}

function Notice({ s, actions }: { s: SessionState; actions: PanelActions }) {
  if (s.status === 'loading' || s.status === 'idle')
    return <div className="notice muted">Loading captions…</div>;
  if (s.status === 'no-captions')
    return <div className="notice muted">{s.error ?? 'This video has no captions.'}</div>;
  if (s.status === 'error')
    return (
      <div className="notice error">
        <span>{s.error}</span>
        <button onClick={actions.reload}>Try again</button>
      </div>
    );
  if (s.needsSetup)
    return (
      <div className="notice">
        <span>Connect an OpenAI-compatible model to translate these captions.</span>
        <button onClick={actions.openOptions}>Set up</button>
      </div>
    );
  if (s.translateError)
    return (
      <div className="notice error">
        <span>{s.translateError}</span>
        <button onClick={actions.retry}>Retry</button>
        <button onClick={actions.openOptions}>Settings</button>
      </div>
    );
  return null;
}

interface RowProps {
  cue: Cue;
  translation: string | undefined;
  state: 'past' | 'active' | 'future';
  mode: DisplayMode;
  pending: boolean;
  onSeek(ms: number): void;
}

const Row = memo(function Row({ cue, translation, state, mode, pending, onSeek }: RowProps) {
  const showSource = mode !== 'target' || (!translation && !pending);
  const showTarget = mode !== 'source';
  return (
    <div className={`row ${state}`} data-id={cue.id} onClick={() => onSeek(cue.start)}>
      <span className="time">{formatTimestamp(cue.start)}</span>
      <div className="text">
        {showSource && <p className="src">{cue.text}</p>}
        {showTarget &&
          (translation ? (
            <p className="tr">{translation}</p>
          ) : pending ? (
            <p className="tr skeleton" aria-label="Translating" />
          ) : null)}
      </div>
    </div>
  );
});
