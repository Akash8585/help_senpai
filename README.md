<p align="center"><img src="src/assets/logo.svg" width="112" alt="Senpai logo" /></p>

# Senpai

<p>
  <a href="https://akash8585.github.io/help_senpai/"><b>Website</b></a> ·
  <a href="https://github.com/Akash8585/help_senpai/releases/latest/download/Senpai-Setup.exe"><b>Download for Windows</b></a> ·
  <a href="https://github.com/Akash8585/help_senpai/releases">All releases</a>
</p>

A real-time AI assistant for calls, interviews, presentations and meetings. Senpai listens to the conversation,
reads your screen on demand, and shows short, ready-to-use answers in a transparent always-on-top overlay.

Every model call goes through [OpenRouter](https://openrouter.ai), so one API key gives you any chat, vision and
speech-to-text model it hosts. A fully offline **Local AI** mode (llama.cpp + whisper.cpp) is also included.

> Senpai is a fork of [sohzm/cheating-daddy](https://github.com/sohzm/cheating-daddy), licensed under GPL-3.0.
> The original Gemini Live / Groq pipeline was replaced with OpenRouter.

## Features

- **Any model via OpenRouter**: pick the answer model, screenshot (vision) model and speech-to-text model from the live OpenRouter catalog
- **Live transcription**: speech is detected locally, then each utterance is transcribed by an OpenRouter STT model (Whisper by default)
- **Notes side panel**: keep prep as chunks (STAR stories, talking points, formulas, questions to ask), paste a long doc to split it into chunks, and open them next to the answers during a session with `[notes]`. Save any AI answer as a note in one click; mark chunks "Share with AI" to use them in answers
- **Your context, built in**: add your resume, portfolio, GitHub repos (with instructions for what to do with them) and the company assignment on the Context page; answers are grounded in them
- **Technical answers**: coding and DSA (approach, complexity, full code), system design (requirements → architecture → scaling → trade-offs), debugging and concepts
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

## Context page

| Source             | How to add                                      | What is read                                                               |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------------------- |
| Resume             | Upload PDF / DOCX / TXT, or paste text          | Full text                                                                  |
| Portfolio          | Link                                            | Page rendered in a hidden browser (JavaScript sites work), plus its links  |
| Company assignment | Link, upload, or paste                          | Web page, Google Doc shared by link, PDF, Notion page, GitHub file or repo |
| GitHub repos       | `github.com/owner/repo` (or `/tree/branch/dir`) | File tree, README, manifests, and source files ranked by relevance         |

- "What should Senpai do with these repos?" tells the model how to use the code (e.g. "they'll ask me to extend
  the take-home with pagination").
- Large repos are fitted into a ~150k-character budget: every relevant file gets a fair share, and long files are
  cut with an outline of their remaining functions/classes. Lockfiles, build output and `node_modules` are skipped.
- Private repos or heavy use need a GitHub token (read-only "Contents" access is enough).
- LinkedIn requires a login, so export your profile as PDF and upload it as your resume.
- The page shows how many tokens of context are sent with every answer. The context is part of the system prompt,
  which Gemini caches automatically and other providers cache via a `cache_control` marker, so repeat answers are
  billed at the cheaper cached rate where supported.
- Changes apply to the next session. Local AI mode only gets the first ~12k characters (8K-token context window).

## Setup

1. `npm install`
2. `npm start`
3. On the Home screen pick a **Quick setup** and paste the keys it asks for. A green status line confirms each key.

### Free or paid

Answers and transcription can use different providers. Everything runs through hosted APIs; nothing is installed locally.

| Quick setup                | Answers + screenshots                        | Speech-to-text                      | Cost                                                                                                                  |
| -------------------------- | -------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Free**                   | Google Gemini `gemini-3.8-flash` (free tier) | Groq `whisper-large-v3-turbo`       | $0. Free keys from [AI Studio](https://aistudio.google.com/apikey) and [Groq](https://console.groq.com/keys), no card |
| **OpenRouter free models** | OpenRouter `google/gemma-4-31b-it:free`      | Groq `whisper-large-v3-turbo`       | $0. 50 answers/day, or 1,000/day after a one-time $10 top-up                                                          |
| **OpenRouter (paid)**      | OpenRouter `google/gemini-3.8-flash`         | OpenRouter `whisper-large-v3-turbo` | Pay per use (about 1¢ per hour of audio plus answers)                                                                 |

Free-tier notes:

- Free tiers have per-minute and per-day limits. When one is hit, Senpai shows which provider limited the request.
- Google may use Gemini free-tier content to improve its products. Some free OpenRouter providers may log prompts;
  review [OpenRouter privacy settings](https://openrouter.ai/settings/privacy) before sending your resume or code.
- Free OpenRouter models fall back to OpenRouter's free-model router automatically when the chosen one is busy.
- Groq is used for transcription because every spoken sentence is one request; its free tier allows about 2,000 a day.

Any model id from the provider's catalog works (the fields suggest models once a key is saved). The screenshot model
must accept image input. Web search is available with OpenRouter answers only.

## Keyboard shortcuts

| Action                          | Shortcut                |
| ------------------------------- | ----------------------- |
| Start session / screenshot help | `Ctrl/Cmd + Enter`      |
| Move window                     | `Ctrl/Cmd + Arrow keys` |
| Show / hide                     | `Ctrl/Cmd + \`          |
| Click-through                   | `Ctrl/Cmd + M`          |
| Previous / next answer          | `Ctrl/Cmd + [` / `]`    |
| Emergency erase                 | `Ctrl/Cmd + Shift + E`  |

All shortcuts can be changed in Settings. Only one copy of Senpai runs at a time (launching it again focuses the open window); if another app already uses a shortcut, the sidebar shows a warning.

## Audio capture

- **macOS**: [SystemAudioDump](https://github.com/Mohammed-Yasin-Mulla/Sound) for system audio
- **Windows**: loopback audio through screen capture
- **Linux**: system audio through screen capture if available, otherwise microphone

Choose speaker only, microphone only, or both under Settings → Audio Input.

## Data and privacy

- Settings, your API key and session history are stored locally in `senpai-config` (`%APPDATA%` on Windows,
  `~/Library/Application Support` on macOS, `~/.config` on Linux).
- Context page items are stored as extracted text in `senpai-config/knowledge.json`; a GitHub token, if added, is
  stored in `credentials.json`.
- In OpenRouter mode, detected speech segments, transcripts, screenshots and your Context page material are sent to OpenRouter and the model
  provider you selected. Local AI mode keeps everything on your machine.

## Development

```
npm install
npm start          # run the app
npm run make       # build installers (Electron Forge)
npx prettier --write src
```

Key files:

- `src/utils/providers.js` — OpenRouter, Google Gemini and Groq clients (streaming chat, speech-to-text, model lists, key checks)
- `src/utils/speechSegmenter.js` — voice activity detection, resampling, WAV encoding
- `src/utils/session.js` — session orchestration and IPC handlers
- `src/utils/notes.js` / `src/components/views/NotesPanel.js` — note chunks, Notes page and in-session side panel
- `src/utils/knowledge.js` — Context page backend (resume/portfolio/assignment/repo fetching, prompt budget)
- `src/utils/localai.js` — local llama.cpp / whisper.cpp mode
- `src/components/views/MainView.js` — setup screen
- `docs/` — the launch website (static, served by GitHub Pages from `main` / `docs`)

## License

GPL-3.0, see [LICENSE](LICENSE). Based on [cheating-daddy](https://github.com/sohzm/cheating-daddy) by sohzm.
