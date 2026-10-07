# Repo Guidelines

Senpai is an Electron app (plain JavaScript + Lit web components) that captures screen and audio and shows
AI answers in an overlay. All hosted model calls go through OpenRouter. It is a fork of
[`cheating-daddy`](https://github.com/sohzm/cheating-daddy) (GPL-3.0); upstream is configured as the `upstream`
git remote for cherry-picking UI/capture fixes.

## Getting started

```
npm install
npm start
```

## Architecture

- `src/index.js` — Electron main entry; storage IPC handlers.
- `src/utils/session.js` — owns the active provider (`openrouter` or `local`), routes audio/screenshots/text,
  records history, and registers the session IPC handlers.
- `src/utils/openrouter.js` — OpenRouter REST client: `streamChat` (SSE), `transcribe`
  (`/audio/transcriptions`), `listModels`, `getKeyInfo`.
- `src/utils/speechSegmenter.js` — energy VAD that turns 24 kHz PCM16 chunks into 16 kHz utterances. Shared by
  both providers.
- `src/utils/localai.js`, `src/utils/native-ai-runtime.js` — offline llama.cpp + whisper.cpp mode.
- `src/utils/renderer.js` — renderer-side capture and the `window.senpai` API used by components.
- `src/storage.js` — JSON files in the `senpai-config` directory (config, credentials, preferences, history).
- `src/components/` — Lit views; `SenpaiApp.js` is the shell.

Renderer → main messages: `initialize-openrouter`, `initialize-local`, `send-audio-content` (system audio),
`send-mic-audio-content`, `send-image-content`, `send-text-message`, `close-session`, `openrouter:list-models`,
`openrouter:key-info`. Main → renderer: `new-response`, `update-response`, `update-status`, `usage-update`,
`save-conversation-turn`, `save-screen-analysis`.

## Style

Run `npx prettier --write src` before committing (four-space indentation, print width 150, single quotes).
`src/assets` is ignored. There is no linter.

## Testing

No automated test suite yet. At minimum, after changes: `npm start`, add an OpenRouter key, start a session, and
check that speech, typed messages and `Ctrl+Enter` screenshots all produce answers. Validate any parameters that
cross the IPC boundary.

## Privacy

Keep data local except what a request must send to OpenRouter. Never log API keys.
