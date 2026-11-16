import { storage } from 'wxt/utils/storage';
import type { DisplayMode } from './types';

export interface Settings {
  enabled: boolean;
  targetLang: string;
  displayMode: DisplayMode;
  showOverlay: boolean;
  showPanel: boolean;
  /** Show the translation above the original line in the video overlay. */
  translationFirst: boolean;
  overlayScale: number;

  /** OpenAI-compatible endpoint, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  /** Omitted from requests when null; some reasoning models reject it. */
  temperature: number | null;

  batchSize: number;
  concurrency: number;
  contextLines: number;
  extraInstructions: string;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  targetLang: 'zh-CN',
  displayMode: 'bilingual',
  showOverlay: true,
  showPanel: true,
  translationFirst: true,
  overlayScale: 1,

  baseUrl: '',
  model: '',
  temperature: null,

  batchSize: 20,
  concurrency: 2,
  contextLines: 8,
  extraInstructions: '',
};

/** Synced across the user's browsers. Never holds secrets. */
export const settingsItem = storage.defineItem<Partial<Settings>>('sync:settings', {
  fallback: {},
});

/** Kept in local storage only so the key never leaves this device via sync. */
export const apiKeyItem = storage.defineItem<string>('local:apiKey', { fallback: '' });

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await settingsItem.getValue()) };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await settingsItem.setValue(next);
  return next;
}

export function watchSettings(cb: (s: Settings) => void): () => void {
  return settingsItem.watch((v) => cb({ ...DEFAULT_SETTINGS, ...v }));
}

/** Settings that change what the AI produces; changing them invalidates translations. */
export function translationFingerprint(s: Settings): string {
  return JSON.stringify([s.baseUrl, s.model, s.targetLang, s.extraInstructions]);
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  modelHint: string;
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-5-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat' },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelHint: 'openai/gpt-5-mini',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelHint: 'gemini-2.5-flash',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    modelHint: 'qwen3',
    note: 'Start Ollama with OLLAMA_ORIGINS=chrome-extension://* so the extension may call it.',
  },
];
