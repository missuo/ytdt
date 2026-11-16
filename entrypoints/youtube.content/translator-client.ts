import { browser, type Browser } from 'wxt/browser';
import { TRANSLATE_PORT, type PortRequest, type PortResponse } from '@/lib/messages';
import type { SummaryJob, TranslateJob, VideoSummary } from '@/lib/types';

export class TranslateError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

interface Handler {
  onLine?: (id: number, text: string) => void;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export interface Cancellable<T> {
  promise: Promise<T>;
  cancel(): void;
}

/**
 * Talks to the background worker over one long-lived port. Pings keep the
 * MV3 service worker alive while requests are in flight.
 */
export class TranslatorClient {
  private port: Browser.runtime.Port | null = null;
  private handlers = new Map<string, Handler>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  private connect(): Browser.runtime.Port {
    if (this.port) return this.port;
    const port = browser.runtime.connect({ name: TRANSLATE_PORT });
    port.onMessage.addListener((msg: PortResponse) => this.dispatch(msg));
    port.onDisconnect.addListener(() => {
      this.port = null;
      this.stopPing();
      const err = new TranslateError('Connection to the extension was lost.', 'network');
      for (const h of this.handlers.values()) h.reject(err);
      this.handlers.clear();
    });
    this.port = port;
    return port;
  }

  private dispatch(msg: PortResponse) {
    const h = this.handlers.get(msg.reqId);
    if (!h) return;
    switch (msg.type) {
      case 'line':
        h.onLine?.(msg.id, msg.text);
        return;
      case 'done':
        h.resolve(undefined);
        break;
      case 'summary':
        h.resolve(msg.summary);
        break;
      case 'error':
        h.reject(new TranslateError(msg.message, msg.code));
        break;
    }
    this.handlers.delete(msg.reqId);
    if (!this.handlers.size) this.stopPing();
  }

  private startPing() {
    this.pingTimer ??= setInterval(() => this.port?.postMessage({ type: 'ping' } satisfies PortRequest), 20_000);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private request<T>(
    build: (reqId: string) => PortRequest,
    onLine?: (id: number, text: string) => void,
  ): Cancellable<T> {
    const reqId = `r${++this.seq}`;
    let cancel = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      try {
        const port = this.connect();
        this.handlers.set(reqId, { resolve, reject, onLine });
        this.startPing();
        port.postMessage(build(reqId));
        cancel = () => {
          if (!this.handlers.delete(reqId)) return;
          this.port?.postMessage({ type: 'abort', reqId } satisfies PortRequest);
          reject(new TranslateError('Cancelled', 'cancelled'));
        };
      } catch (e) {
        reject(new TranslateError((e as Error).message, 'network'));
      }
    });
    return { promise, cancel: () => cancel() };
  }

  translate(job: TranslateJob, onLine: (id: number, text: string) => void): Cancellable<void> {
    return this.request((reqId) => ({ type: 'translate', reqId, job }), onLine);
  }

  summarize(job: SummaryJob): Cancellable<VideoSummary> {
    return this.request((reqId) => ({ type: 'summarize', reqId, job }));
  }

  dispose() {
    this.port?.disconnect();
    this.port = null;
    this.stopPing();
    this.handlers.clear();
  }
}
