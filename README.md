# YouTube Dual Subtitles

A Chrome extension (Manifest V3) that adds dual-language subtitles to YouTube:

- **Video overlay**: the translation and the original line, shown together on the player (replaces YouTube's own captions while active).
- **Timeline panel**: the empty column next to the video becomes a synced, bilingual transcript. The current line is highlighted and followed; click any line to jump there. You can switch between Dual / Original / Translated, pick the source caption track, and export `.srt` files.
- **Context-aware AI translation**: the full caption track is fetched as soon as the video opens and translated in batches through any OpenAI-compatible API.

## How the translation keeps context

1. **Whole-video pass.** One request reads a sample of the full transcript plus the title and description, and returns a short summary and a glossary of names and recurring terms.
2. **Batched lines.** Each batch (20 lines by default) includes:
   - the earlier lines **with their existing translations**, so terminology, pronouns and tone carry forward,
   - the next few lines as look-ahead, so sentence fragments that continue on the next line are translated correctly,
   - the summary and glossary.
3. **Playhead first.** The batch under the playhead runs first, then everything after it, then the rest. Seeking re-prioritises the queue.
4. **Streaming.** Translations appear line by line as the model writes them.
5. **Retries.** Lines the model skipped are retried in smaller batches. Rate limits back off; auth or config errors stop the queue and show a message.
6. **Cache.** Results are cached per video, track, language and model, so a rewatch costs nothing.

Auto-generated (ASR) captions arrive word by word; they are re-segmented into sentence-sized cues using punctuation, pauses and length limits before translation.

## Supported providers

Any Chat Completions-compatible endpoint. Presets are included for OpenAI, DeepSeek, OpenRouter, Gemini (OpenAI layer) and Ollama. For Ollama, start it with `OLLAMA_ORIGINS=chrome-extension://*`.

The API key is kept in `chrome.storage.local` (never synced). Host access is requested only for the API origin you configure.

## Stack

WXT 0.21 (Vite 8), React 19, TypeScript 7, pnpm. No runtime dependencies besides React.

## Development

```bash
pnpm install
pnpm dev        # launches Chrome with the extension and hot reload
pnpm build      # production build in .output/chrome-mv3
pnpm zip        # store-ready zip
pnpm compile    # type-check
```

Load `.output/chrome-mv3` via `chrome://extensions` → Developer mode → Load unpacked.

## Layout

```
entrypoints/
  background.ts               Service worker: calls the AI endpoint, streams lines back over a port
  youtube-main.content.ts     MAIN-world agent: reads the player, fetches caption tracks
  youtube.content/            Isolated content script
    app.tsx                     Navigation, mounting, playback sync
    session.ts                  Per-video state, translation queue, cache
    Panel.tsx / Overlay.tsx     UI (rendered in shadow roots)
  popup/  options/            Quick toggles and full settings
lib/
  captions.ts                 json3 parsing, ASR segmentation, track choice
  prompt.ts                   Prompts and the streaming "[id] text" parser
  llm.ts                      OpenAI-compatible streaming client
  settings.ts  cache.ts  srt.ts  languages.ts
```

### Caption fetching

YouTube's `timedtext` endpoint only returns captions for requests carrying the player's proof-of-origin token (`pot`). The MAIN-world script does not patch any page APIs, because that trips YouTube's integrity checks and breaks playback. Instead it watches the player's own timedtext requests with a `PerformanceObserver`, reuses their token to fetch the chosen track as `json3`, and briefly toggles CC on (then restores it) when the player hasn't requested captions yet.
