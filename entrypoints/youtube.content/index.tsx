import { defineContentScript } from 'wxt/utils/define-content-script';
import { getSettings } from '@/lib/settings';
import { App } from './app';

export default defineContentScript({
  matches: ['*://www.youtube.com/*'],
  runAt: 'document_idle',
  cssInjectionMode: 'manual',
  async main(ctx) {
    const app = new App(ctx, await getSettings());
    app.start();
  },
});
