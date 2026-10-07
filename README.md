# Senpai

A real-time AI assistant for calls, interviews, presentations and meetings. Senpai listens to the conversation,
reads your screen on demand, and shows short, ready-to-use answers in a transparent always-on-top overlay.

Every model call goes through [OpenRouter](https://openrouter.ai), so one API key gives you any chat, vision and
speech-to-text model it hosts. A fully offline **Local AI** mode (llama.cpp + whisper.cpp) is also included.

> Senpai is a fork of [sohzm/cheating-daddy](https://github.com/sohzm/cheating-daddy), licensed under GPL-3.0.
> The original Gemini Live / Groq pipeline was replaced with OpenRouter.

## Features

- **Any model via OpenRouter**: pick the answer model, screenshot (vision) model and speech-to-text model from the live OpenRouter catalog
- **Live transcription**: speech is detected locally, then each utterance is transcribed by an OpenRouter STT model (Whisper by default)
- **Screen help**: `Ctrl/Cmd + Enter` sends a screenshot to a vision model
- **Speaker-aware**: system audio is treated as the other party, your microphone as you (in "both" mode it's context only)
- **Optional web search**: OpenRouter's `web` plugin for questions about recent events
- **Live cost meter**: shows how much the current session has cost on OpenRouter
- **Profiles**: Interview, Sales Call, Business Meeting, Presentation, Negotiation, Exam
- **Transparent overlay**, click-through mode, emergency erase, session history
- **Local AI mode**: runs Qwen + Whisper on your machine, no network calls to an AI service

## How it works

```
system audio / mic ──► voice activity detection (local) ──► OpenRouter /audio/transcriptions
                                                                         │
                                       transcript ("[Them]: …" / "[Me]: …")
                                                                         ▼
screenshot (Ctrl+Enter) ─────────────────────────────────────► OpenRouter /chat/completions (streamed)
                                                                         │
                                                                         ▼
                                                              overlay + session history
```

If the other person keeps talking while an answer is streaming, Senpai cancels that answer and re-asks with the
full question.

## Setup

1. Get an API key at [openrouter.ai/keys](https://openrouter.ai/keys) and add some credit
2. `npm install`
3. `npm start`
4. Paste the key on the home screen. A green status line confirms it's valid.

### Default models

| Purpose        | Default                         | Setting              |
| -------------- | ------------------------------- | -------------------- |
| Answers        | `google/gemini-3.8-flash`       | Home → AI responses  |
| Screenshots    | `google/gemini-3.8-flash`       | Home → AI responses  |
| Speech-to-text | `openai/whisper-large-v3-turbo` | Home → Transcription |

Any model id from [openrouter.ai/models](https://openrouter.ai/models) works. The screenshot model must accept image
input. "Disable thinking" sends `reasoning.effort = "none"` for faster answers from reasoning models.

## Keyboard shortcuts

| Action                          | Shortcut                |
| ------------------------------- | ----------------------- |
| Start session / screenshot help | `Ctrl/Cmd + Enter`      |
| Move window                     | `Ctrl/Cmd + Arrow keys` |
| Show / hide                     | `Ctrl/Cmd + \`          |
| Click-through                   | `Ctrl/Cmd + M`          |
| Previous / next answer          | `Ctrl/Cmd + [` / `]`    |
| Emergency erase                 | `Ctrl/Cmd + Shift + E`  |

All shortcuts can be changed in Settings.

## Audio capture

- **macOS**: [SystemAudioDump](https://github.com/Mohammed-Yasin-Mulla/Sound) for system audio
- **Windows**: loopback audio through screen capture
- **Linux**: system audio through screen capture if available, otherwise microphone

Choose speaker only, microphone only, or both under Settings → Audio Input.

## Data and privacy

- Settings, your API key and session history are stored locally in `senpai-config` (`%APPDATA%` on Windows,
  `~/Library/Application Support` on macOS, `~/.config` on Linux).
- In OpenRouter mode, detected speech segments, transcripts and screenshots are sent to OpenRouter and the model
  provider you selected. Local AI mode keeps everything on your machine.

## Development

```
npm install
npm start          # run the app
npm run make       # build installers (Electron Forge)
npx prettier --write src
```

Key files:

- `src/utils/openrouter.js` — OpenRouter client (streaming chat, STT, model list, key info)
- `src/utils/speechSegmenter.js` — voice activity detection, resampling, WAV encoding
- `src/utils/session.js` — session orchestration and IPC handlers
- `src/utils/localai.js` — local llama.cpp / whisper.cpp mode
- `src/components/views/MainView.js` — setup screen

## License

GPL-3.0, see [LICENSE](LICENSE). Based on [cheating-daddy](https://github.com/sohzm/cheating-daddy) by sohzm.
