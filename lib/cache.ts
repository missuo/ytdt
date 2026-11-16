import { browser } from 'wxt/browser';
import type { VideoSummary } from './types';

const PREFIX = 'tcache:';
const INDEX_KEY = 'tcache-index';
const MAX_ENTRIES = 300;

export interface CachedTranslation {
  translations: (string | null)[];
  summary: VideoSummary | null;
  updatedAt: number;
}

async function hash(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function cacheKey(parts: string[]): Promise<string> {
  return PREFIX + (await hash(parts.join('\u0001')));
}

export async function loadCache(key: string): Promise<CachedTranslation | null> {
  const res = await browser.storage.local.get(key);
  return (res[key] as CachedTranslation | undefined) ?? null;
}

export async function saveCache(key: string, value: CachedTranslation): Promise<void> {
  const res = await browser.storage.local.get(INDEX_KEY);
  const index = ((res[INDEX_KEY] as string[] | undefined) ?? []).filter((k) => k !== key);
  index.push(key);
  const evicted = index.splice(0, Math.max(0, index.length - MAX_ENTRIES));
  if (evicted.length) await browser.storage.local.remove(evicted);
  await browser.storage.local.set({ [key]: value, [INDEX_KEY]: index });
}

export async function deleteCache(key: string): Promise<void> {
  await browser.storage.local.remove(key);
}

export async function clearAllCache(): Promise<number> {
  const all = await browser.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX) || k === INDEX_KEY);
  await browser.storage.local.remove(keys);
  return keys.filter((k) => k !== INDEX_KEY).length;
}
