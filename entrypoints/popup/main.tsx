import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { LANGUAGES } from '@/lib/languages';
import { DEFAULT_SETTINGS, getSettings, updateSettings, watchSettings, type Settings } from '@/lib/settings';
import type { DisplayMode } from '@/lib/types';
import '@/assets/ui.css';
import './style.css';

function Popup() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getSettings().then((v) => {
      setS(v);
      setLoaded(true);
    });
    return watchSettings(setS);
  }, []);

  const set = (patch: Partial<Settings>) => {
    setS((prev) => ({ ...prev, ...patch }));
    void updateSettings(patch);
  };

  const configured = !!(s.baseUrl.trim() && s.model.trim());

  return (
    <main className={loaded ? '' : 'loading'}>
      <header>
        <img src="/icon/48.png" alt="" width={28} height={28} />
        <h1>Dual Subtitles</h1>
        <label className="switch" title="Enable on YouTube">
          <input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        </label>
      </header>

      <fieldset disabled={!s.enabled}>
        <label className="field">
          <span>Translate into</span>
          <select value={s.targetLang} onChange={(e) => set({ targetLang: e.target.value })}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name} · {l.native}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>Show</span>
          <div className="seg">
            {(
              [
                ['bilingual', 'Dual'],
                ['source', 'Original'],
                ['target', 'Translated'],
              ] as [DisplayMode, string][]
            ).map(([id, label]) => (
              <button key={id} className={s.displayMode === id ? 'on' : ''} onClick={() => set({ displayMode: id })}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <label className="switch">
          <span>Subtitles on video</span>
          <input type="checkbox" checked={s.showOverlay} onChange={(e) => set({ showOverlay: e.target.checked })} />
        </label>
        <label className="switch">
          <span>Timeline panel</span>
          <input type="checkbox" checked={s.showPanel} onChange={(e) => set({ showPanel: e.target.checked })} />
        </label>
      </fieldset>

      <footer>
        <span className={configured ? 'ok' : 'err'}>
          {configured ? `● ${s.model}` : '● AI model not configured'}
        </span>
        <button className="btn" onClick={() => browser.runtime.openOptionsPage()}>
          Settings
        </button>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
