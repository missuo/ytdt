import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'YouTube Dual Subtitles',
    description:
      'Dual-language YouTube subtitles with context-aware AI translation and a synced transcript timeline.',
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: ['*://www.youtube.com/*'],
    // The AI endpoint is user-configured; access is requested for that origin only.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_title: 'YouTube Dual Subtitles' },
  },
});
