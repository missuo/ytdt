import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { completeChat, listModels, LlmError, streamChat, type LlmConfig } from '@/lib/llm';
import type { PortRequest, PortResponse, RuntimeRequest, RuntimeResponse } from '@/lib/messages';
import { TRANSLATE_PORT } from '@/lib/messages';
import {
  buildSummaryMessages,
  buildTranslateMessages,
  parseSummary,
  TranslationStreamParser,
} from '@/lib/prompt';
import { apiKeyItem, getSettings } from '@/lib/settings';

async function llmConfig(): Promise<LlmConfig & { extraInstructions: string }> {
  const [s, apiKey] = await Promise.all([getSettings(), apiKeyItem.getValue()]);
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    temperature: s.temperature,
    apiKey,
    extraInstructions: s.extraInstructions,
  };
}

function toError(reqId: string, e: unknown): PortResponse {
  if (e instanceof LlmError) return { type: 'error', reqId, message: e.message, code: e.code };
  return { type: 'error', reqId, message: e instanceof Error ? e.message : String(e), code: 'unknown' };
}

function handlePort(port: Browser.runtime.Port) {
  const jobs = new Map<string, AbortController>();
  let open = true;
  const post = (msg: PortResponse) => {
    if (open) port.postMessage(msg);
  };

  port.onDisconnect.addListener(() => {
    open = false;
    for (const c of jobs.values()) c.abort();
    jobs.clear();
  });

  port.onMessage.addListener(async (msg: PortRequest) => {
    if (msg.type === 'ping') return;
    if (msg.type === 'abort') {
      jobs.get(msg.reqId)?.abort();
      jobs.delete(msg.reqId);
      return;
    }

    const ctrl = new AbortController();
    jobs.set(msg.reqId, ctrl);
    try {
      const cfg = await llmConfig();
      if (msg.type === 'translate') {
        const wanted = new Set(msg.job.lines.map((l) => l.id));
        const parser = new TranslationStreamParser(wanted, (id, text) =>
          post({ type: 'line', reqId: msg.reqId, id, text }),
        );
        const messages = buildTranslateMessages(msg.job, cfg.extraInstructions);
        for await (const chunk of streamChat(cfg, messages, ctrl.signal)) parser.push(chunk);
        parser.end();
        post({ type: 'done', reqId: msg.reqId });
      } else if (msg.type === 'summarize') {
        const text = await completeChat(cfg, buildSummaryMessages(msg.job), ctrl.signal);
        post({ type: 'summary', reqId: msg.reqId, summary: parseSummary(text) });
      }
    } catch (e) {
      if (!ctrl.signal.aborted) post(toError(msg.reqId, e));
    } finally {
      jobs.delete(msg.reqId);
    }
  });
}

async function handleRuntime(msg: RuntimeRequest): Promise<RuntimeResponse> {
  try {
    switch (msg.type) {
      case 'openOptions':
        await browser.runtime.openOptionsPage();
        return { ok: true };
      case 'listModels':
        return { ok: true, models: await listModels(msg) };
      case 'testConnection': {
        const text = await completeChat(msg, [
          { role: 'user', content: 'Translate "Good morning" into French. Reply with the translation only.' },
        ]);
        return { ok: true, text: text.replace(/<think>[\s\S]*?<\/think>/g, '').trim() };
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default defineBackground(() => {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === TRANSLATE_PORT) handlePort(port);
  });

  browser.runtime.onMessage.addListener((msg: RuntimeRequest, _sender, sendResponse) => {
    handleRuntime(msg).then(sendResponse);
    return true;
  });

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') browser.runtime.openOptionsPage();
  });
});
