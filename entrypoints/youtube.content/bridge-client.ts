import { BRIDGE_TAG, type BridgeMethod, type BridgeMethods, type BridgeResponse } from '@/lib/bridge';

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const prefix = Math.random().toString(36).slice(2);
let seq = 0;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as BridgeResponse | undefined;
    if (!data || data[BRIDGE_TAG] !== 'res') return;
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.result);
  });
}

/** Call a handler in the MAIN-world page agent. */
export function callPage<M extends BridgeMethod>(
  method: M,
  params: BridgeMethods[M]['params'],
  timeoutMs = 30_000,
): Promise<BridgeMethods[M]['result']> {
  listen();
  const id = `${prefix}-${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for the YouTube page (${method}).`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v as BridgeMethods[M]['result']);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    window.postMessage({ [BRIDGE_TAG]: 'req', id, method, params }, location.origin);
  });
}
