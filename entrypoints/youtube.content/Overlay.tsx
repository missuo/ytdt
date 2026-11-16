import type { Settings } from '@/lib/settings';
import type { PlaybackState } from './app';
import type { SessionState } from './session';
import { useStore, type Store } from './store';

interface Props {
  session: Store<SessionState>;
  playback: Store<PlaybackState>;
  settings: Store<Settings>;
}

export function Overlay({ session, playback, settings }: Props) {
  const s = useStore(session);
  const cfg = useStore(settings);
  const { activeIndex, visible } = useStore(playback);

  if (!cfg.showOverlay || !visible || s.status !== 'ready') return null;
  const cue = s.cues[activeIndex];
  if (!cue) return null;

  const tr = s.sameLanguage ? undefined : s.translations[activeIndex];
  const mode = s.sameLanguage ? 'source' : cfg.displayMode;
  const src = <span className="line src">{cue.text}</span>;
  const target = tr ? <span className="line tr">{tr}</span> : null;

  let lines;
  if (mode === 'source') lines = [src];
  else if (mode === 'target') lines = [target ?? src];
  else lines = cfg.translationFirst ? [target, src] : [src, target];

  return (
    <div className="wrap" style={{ fontSize: `calc(var(--ytdt-base, 22px) * ${cfg.overlayScale})` }}>
      {lines.map((l, i) => l && <div key={i}>{l}</div>)}
    </div>
  );
}
