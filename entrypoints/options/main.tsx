import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { clearAllCache } from '@/lib/cache';
import { LANGUAGES } from '@/lib/languages';
import type { RuntimeRequest, RuntimeResponse } from '@/lib/messages';
import {
  apiKeyItem,
  DEFAULT_SETTINGS,
  getSettings,
  PROVIDER_PRESETS,
  updateSettings,
  type Settings,
} from '@/lib/settings';
import '@/assets/ui.css';
import './style.css';

type Feedback = { kind: 'ok' | 'err' | 'info'; text: string } | null;

function send(msg: RuntimeRequest): Promise<RuntimeResponse> {
  return browser.runtime.sendMessage(msg);
}

/** Ask for access to the API's origin so the background worker can call it. */
async function ensureHostPermission(baseUrl: string): Promise<boolean> {
  let origin: string;
  try {
    const u = new URL(baseUrl);
    origin = `${u.protocol}//${u.hostname}/*`;
  } catch {
    return false;
  }
  // Call request() first thing so it stays inside the click's user gesture;
  // it resolves true straight away when access was already granted.
  return browser.permissions.request({ origins: [origin] });
}

function Options() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<'save' | 'test' | 'models' | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [cacheMsg, setCacheMsg] = useState('');

  useEffect(() => {
    void Promise.all([getSettings(), apiKeyItem.getValue()]).then(([v, k]) => {
      setS(v);
      setApiKey(k);
    });
  }, []);

  /** Provider fields are saved explicitly (the save click grants host access). */
  const edit = (patch: Partial<Settings>) => {
    setS((p) => ({ ...p, ...patch }));
    setDirty(true);
    setFeedback(null);
  };
  /** Everything else saves instantly. */
  const live = (patch: Partial<Settings>) => {
    setS((p) => ({ ...p, ...patch }));
    void updateSettings(patch);
  };

  const preset = PROVIDER_PRESETS.find((p) => p.baseUrl === s.baseUrl.trim().replace(/\/+$/, ''));

  async function save(): Promise<boolean> {
    setBusy('save');
    try {
      const granted = await ensureHostPermission(s.baseUrl);
      if (!granted) {
        setFeedback({ kind: 'err', text: 'Permission to reach this API was not granted.' });
        return false;
      }
      await updateSettings({
        baseUrl: s.baseUrl.trim(),
        model: s.model.trim(),
        temperature: s.temperature,
      });
      await apiKeyItem.setValue(apiKey.trim());
      setDirty(false);
      setFeedback({ kind: 'ok', text: 'Saved.' });
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    if (dirty && !(await save())) return;
    setBusy('test');
    setFeedback({ kind: 'info', text: 'Sending a test request…' });
    const res = await send({
      type: 'testConnection',
      baseUrl: s.baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: s.model.trim(),
      temperature: s.temperature,
    });
    setBusy(null);
    setFeedback(
      res.ok
        ? { kind: 'ok', text: `Connected. The model replied: “${res.text}”` }
        : { kind: 'err', text: res.error },
    );
  }

  async function loadModels() {
    if (!(await ensureHostPermission(s.baseUrl))) {
      setFeedback({ kind: 'err', text: 'Permission to reach this API was not granted.' });
      return;
    }
    setBusy('models');
    const res = await send({ type: 'listModels', baseUrl: s.baseUrl.trim(), apiKey: apiKey.trim() });
    setBusy(null);
    if (res.ok && res.models?.length) {
      setModels(res.models);
      setFeedback({ kind: 'info', text: `Found ${res.models.length} models. Pick one from the Model field.` });
    } else {
      setFeedback({ kind: 'err', text: res.ok ? 'The endpoint returned no models.' : res.error });
    }
  }

  return (
    <main>
      <header className="top">
        <img src="/icon/128.png" alt="" width={44} height={44} />
        <div>
          <h1>YouTube Dual Subtitles</h1>
          <p className="hint">Context-aware AI subtitle translation with a synced transcript timeline.</p>
        </div>
      </header>

      <section className="card">
        <h2>AI provider</h2>
        <p className="hint">
          Any OpenAI-compatible Chat Completions API works. Requests go straight from your browser to the provider.
        </p>

        <div className="presets">
          {PROVIDER_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`chip${preset?.id === p.id ? ' on' : ''}`}
              onClick={() => edit({ baseUrl: p.baseUrl, model: s.model && preset?.id === p.id ? s.model : '' })}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset?.note && <p className="hint note">{preset.note}</p>}

        <label className="field">
          <span>API base URL</span>
          <input
            type="url"
            placeholder="https://api.example.com/v1"
            value={s.baseUrl}
            onChange={(e) => edit({ baseUrl: e.target.value })}
          />
        </label>

        <label className="field">
          <span>API key</span>
          <div className="row">
            <input
              type={showKey ? 'text' : 'password'}
              placeholder={preset?.id === 'ollama' ? 'Not needed for Ollama' : 'sk-…'}
              value={apiKey}
              autoComplete="off"
              onChange={(e) => {
                setApiKey(e.target.value);
                setDirty(true);
              }}
            />
            <button className="btn" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <small className="hint">Stored only on this device, never synced.</small>
        </label>

        <label className="field">
          <span>Model</span>
          <div className="row">
            <input
              type="text"
              list="model-list"
              placeholder={preset ? `e.g. ${preset.modelHint}` : 'Model ID'}
              value={s.model}
              onChange={(e) => edit({ model: e.target.value })}
            />
            <button className="btn" disabled={!s.baseUrl || busy !== null} onClick={loadModels}>
              {busy === 'models' ? 'Loading…' : 'Fetch list'}
            </button>
          </div>
          <datalist id="model-list">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>

        <label className="field narrow">
          <span>Temperature</span>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            placeholder="Provider default"
            value={s.temperature ?? ''}
            onChange={(e) => edit({ temperature: e.target.value === '' ? null : Number(e.target.value) })}
          />
          <small className="hint">Leave empty for reasoning models that reject this parameter.</small>
        </label>

        <div className="actions">
          <button className="btn primary" disabled={!dirty || busy !== null} onClick={save}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button className="btn" disabled={!s.baseUrl || !s.model || busy !== null} onClick={test}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {feedback && <span className={`feedback ${feedback.kind}`}>{feedback.text}</span>}
        </div>
      </section>

      <section className="card">
        <h2>Translation</h2>
        <div className="grid">
          <label className="field">
            <span>Target language</span>
            <select value={s.targetLang} onChange={(e) => live({ targetLang: e.target.value })}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} · {l.native}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Lines per request</span>
            <input
              type="number"
              min={5}
              max={60}
              value={s.batchSize}
              onChange={(e) => live({ batchSize: clamp(Number(e.target.value), 5, 60) })}
            />
          </label>
          <label className="field">
            <span>Context lines</span>
            <input
              type="number"
              min={0}
              max={30}
              value={s.contextLines}
              onChange={(e) => live({ contextLines: clamp(Number(e.target.value), 0, 30) })}
            />
          </label>
          <label className="field">
            <span>Parallel requests</span>
            <input
              type="number"
              min={1}
              max={6}
              value={s.concurrency}
              onChange={(e) => live({ concurrency: clamp(Number(e.target.value), 1, 6) })}
            />
          </label>
        </div>
        <p className="hint">
          Each request carries the earlier lines with their translations, the next few lines, and a summary plus
          glossary of the whole video, so names and terms stay consistent. Use 1 parallel request for the strictest
          continuity.
        </p>
        <label className="field">
          <span>Extra instructions</span>
          <textarea
            placeholder="e.g. Keep technical terms in English. Use a casual tone."
            value={s.extraInstructions}
            onChange={(e) => live({ extraInstructions: e.target.value })}
          />
        </label>
      </section>

      <section className="card">
        <h2>Display</h2>
        <label className="switch">
          <span>Subtitles on the video</span>
          <input type="checkbox" checked={s.showOverlay} onChange={(e) => live({ showOverlay: e.target.checked })} />
        </label>
        <label className="switch">
          <span>Timeline panel beside the video</span>
          <input type="checkbox" checked={s.showPanel} onChange={(e) => live({ showPanel: e.target.checked })} />
        </label>
        <label className="switch">
          <span>Translation above the original line</span>
          <input
            type="checkbox"
            checked={s.translationFirst}
            onChange={(e) => live({ translationFirst: e.target.checked })}
          />
        </label>
        <label className="field">
          <span>Subtitle size · {Math.round(s.overlayScale * 100)}%</span>
          <input
            type="range"
            min={0.6}
            max={1.8}
            step={0.05}
            value={s.overlayScale}
            onChange={(e) => live({ overlayScale: Number(e.target.value) })}
          />
        </label>
      </section>

      <section className="card">
        <h2>Cache</h2>
        <p className="hint">Finished translations are cached per video, track, language and model.</p>
        <div className="actions">
          <button
            className="btn"
            onClick={async () => {
              const n = await clearAllCache();
              setCacheMsg(`Removed ${n} cached ${n === 1 ? 'video' : 'videos'}.`);
            }}
          >
            Clear cached translations
          </button>
          {cacheMsg && <span className="feedback info">{cacheMsg}</span>}
        </div>
      </section>
    </main>
  );
}

function clamp(n: number, min: number, max: number) {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
