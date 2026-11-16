import type { LlmErrorCode } from './llm';
import type { SummaryJob, TranslateJob, VideoSummary } from './types';

export const TRANSLATE_PORT = 'ytdt-translate';

/** Content script -> background, over a long-lived port. */
export type PortRequest =
  | { type: 'ping' }
  | { type: 'translate'; reqId: string; job: TranslateJob }
  | { type: 'summarize'; reqId: string; job: SummaryJob }
  | { type: 'abort'; reqId: string };

/** Background -> content script. */
export type PortResponse =
  | { type: 'line'; reqId: string; id: number; text: string }
  | { type: 'done'; reqId: string }
  | { type: 'summary'; reqId: string; summary: VideoSummary }
  | { type: 'error'; reqId: string; message: string; code: LlmErrorCode | 'unknown' };

/** One-off runtime messages (popup / options -> background). */
export type RuntimeRequest =
  | { type: 'openOptions' }
  | { type: 'testConnection'; baseUrl: string; apiKey: string; model: string; temperature: number | null }
  | { type: 'listModels'; baseUrl: string; apiKey: string };

export type RuntimeResponse =
  | { ok: true; text?: string; models?: string[] }
  | { ok: false; error: string };
