// Session orchestration: owns the active mode (hosted APIs or local AI), routes captured
// audio / screenshots / typed text to it, and records conversation history.
//
// API pipeline (answers and transcription can use different providers, see providers.js):
//   PCM audio -> speechSegmenter (VAD) -> transcription provider -> chat provider (streamed) -> renderer

const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const { getProviderApiKey, getConfig, getPreferences } = require('../storage');
const { PROVIDERS, streamChat, transcribe, listModels, checkKey, describeProviders } = require('./providers');
const { createSpeechSegmenter, createWavBuffer } = require('./speechSegmenter');
const { startTransportLog, logTransportEvent, closeTransportLog } = require('./transportLogger');
const { buildKnowledgeSection } = require('./knowledge');

// Lazy-loaded to avoid circular dependency (localai.js imports from session.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

// Mode: 'api' (hosted providers) or 'local'. null when no session is running.
let currentProviderMode = null;

// Conversation tracking (persisted to history)
let currentSessionId = null;
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;

// API session state
let apiSession = null;

let systemAudioProc = null;

const MAX_HISTORY_CHARS = 48000;
const MAX_HISTORY_MESSAGES = 40;
// Roughly 1024 tokens, the smallest prompt providers will cache.
const CACHE_MIN_CHARS = 4500;

const TRANSCRIPT_FORMAT_NOTE = `

**TRANSCRIPT FORMAT:**
You receive a live speech-to-text transcript of the conversation. Lines are labelled by speaker:
- [Them]: the other party (interviewer, prospect, audience, etc.). Respond to what they say.
- [Me]: the user you are assisting. Use this only as context for what has already been said.
Transcripts can contain recognition errors; infer the intended meaning. If the latest [Them] line is small talk or filler that needs no help, reply with a very short acknowledgement or suggestion.`;

// Whisper-style STT models take ISO-639-1 codes; the UI stores BCP-47 locales.
const LANGUAGE_OVERRIDES = { cmn: 'zh' };
function toIso639_1(locale) {
    if (!locale) return undefined;
    const base = locale.split('-')[0].toLowerCase();
    return LANGUAGE_OVERRIDES[base] || base;
}

let mainWindow = null;

function setMainWindow(win) {
    mainWindow = win;
}

function sendToRenderer(channel, data) {
    // Target the app window explicitly: hidden windows (used to read web pages) also exist.
    const target =
        mainWindow && !mainWindow.isDestroyed()
            ? mainWindow
            : BrowserWindow.getAllWindows().find(win => !win.isSenpaiFetchWindow && !win.isDestroyed());
    target?.webContents.send(channel, data);
}

// ============ CONVERSATION HISTORY ============

function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    startTransportLog(currentSessionId);
    conversationHistory = [];
    screenAnalysisHistory = [];
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);

    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
    };

    screenAnalysisHistory.push(analysisEntry);

    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

// ============ OPENROUTER SESSION ============

function trimChatHistory(history) {
    let totalChars = 0;
    const trimmed = [];

    for (let i = history.length - 1; i >= 0 && trimmed.length < MAX_HISTORY_MESSAGES; i--) {
        const turnChars = (history[i].content || '').length;
        if (trimmed.length > 0 && totalChars + turnChars > MAX_HISTORY_CHARS) break;
        totalChars += turnChars;
        trimmed.unshift(history[i]);
    }

    // Chat models expect the first non-system message to come from the user.
    while (trimmed.length > 1 && trimmed[0].role !== 'user') {
        trimmed.shift();
    }

    return trimmed;
}

/** Append text to the conversation, merging into the trailing user message if it is still unanswered. */
function appendUserText(session, text) {
    const last = session.chatHistory[session.chatHistory.length - 1];
    if (last && last.role === 'user') {
        last.content += `\n${text}`;
    } else {
        session.chatHistory.push({ role: 'user', content: text });
    }
}

function addUsageCost(session, usage) {
    const cost = Number(usage?.cost);
    if (!Number.isFinite(cost) || cost <= 0) return;
    session.cost += cost;
    sendToRenderer('usage-update', { cost: session.cost });
}

const ANSWER_PROVIDERS = ['openrouter', 'gemini'];
const TRANSCRIPTION_PROVIDERS = ['openrouter', 'groq', 'gemini'];

/** Which provider and models handle answers and transcription, from config. */
function resolveProviderSetup(config) {
    const answerProvider = ANSWER_PROVIDERS.includes(config.answerProvider) ? config.answerProvider : 'openrouter';
    const transcriptionProvider = TRANSCRIPTION_PROVIDERS.includes(config.transcriptionProvider) ? config.transcriptionProvider : 'openrouter';
    const models = {
        openrouter: { chat: config.openrouterModel, vision: config.openrouterVisionModel, transcription: config.openrouterTranscriptionModel },
        gemini: { chat: config.geminiModel, vision: config.geminiVisionModel, transcription: config.geminiTranscriptionModel },
        groq: { transcription: config.groqTranscriptionModel },
    };
    const chatModel = models[answerProvider].chat || PROVIDERS[answerProvider].defaults.chatModel;
    return {
        answerProvider,
        transcriptionProvider,
        chatModel,
        visionModel: models[answerProvider].vision || chatModel,
        transcriptionModel: models[transcriptionProvider].transcription || PROVIDERS[transcriptionProvider].defaults.transcriptionModel,
    };
}

// Free OpenRouter models are often busy; let OpenRouter fall back to its free-model router.
function fallbacksFor(provider, model) {
    return provider === 'openrouter' && /:free$/.test(model) ? ['openrouter/free'] : undefined;
}

function createApiSession({ keys, setup, config, preferences, profile, customPrompt, language }) {
    // Web search is an OpenRouter plugin; other providers would only be told about a tool they lack.
    const webSearch = preferences.webSearchEnabled === true && setup.answerProvider === 'openrouter';
    const audioMode = preferences.audioMode || 'speaker_only';

    const session = {
        keys,
        answerProvider: setup.answerProvider,
        transcriptionProvider: setup.transcriptionProvider,
        chatModel: setup.chatModel,
        visionModel: setup.visionModel,
        transcriptionModel: setup.transcriptionModel,
        disableReasoning: config.disableReasoning !== false,
        webSearch,
        language: toIso639_1(language),
        // In mic-only mode the mic is the only input, so it carries the other party's voice.
        micTriggersAnswers: audioMode === 'mic_only',
        systemPrompt: getSystemPrompt(profile, customPrompt, webSearch, buildKnowledgeSection()) + TRANSCRIPT_FORMAT_NOTE,
        chatHistory: [],
        cost: 0,
        active: true,
        inflight: null,
        transcriptionChain: Promise.resolve(),
        segmenters: {},
    };

    for (const source of ['system', 'mic']) {
        session.segmenters[source] = createSpeechSegmenter({
            onSpeechStart: () => {
                if (!session.inflight) sendToRenderer('update-status', 'Listening... (speech detected)');
            },
            onSegment: pcm16k => queueTranscription(session, source, pcm16k),
        });
    }

    return session;
}

function queueTranscription(session, source, pcm16k) {
    // Transcribe sequentially so utterances stay in spoken order.
    session.transcriptionChain = session.transcriptionChain
        .then(() => handleUtterance(session, source, pcm16k))
        .catch(error => console.error('[API] Utterance handling error:', error));
}

async function handleUtterance(session, source, pcm16k) {
    if (!session.active) return;

    if (!session.inflight) sendToRenderer('update-status', 'Transcribing...');
    logTransportEvent('api.stt.request', {
        provider: session.transcriptionProvider,
        model: session.transcriptionModel,
        source,
        bytes: pcm16k.length,
    });

    let text;
    try {
        const result = await transcribe({
            provider: session.transcriptionProvider,
            apiKey: session.keys[session.transcriptionProvider],
            model: session.transcriptionModel,
            wavBuffer: createWavBuffer(pcm16k),
            language: session.language,
        });
        text = result.text;
        addUsageCost(session, result.usage);
        logTransportEvent('api.stt.response', { source, text, usage: result.usage });
    } catch (error) {
        console.error('[API] Transcription error:', error);
        logTransportEvent('api.stt.error', { error: error.message });
        sendToRenderer('update-status', 'Transcription error: ' + error.message);
        return;
    }

    if (!session.active) return;

    if (!text || text.replace(/[^\p{L}\p{N}]/gu, '').length < 2) {
        if (!session.inflight) sendToRenderer('update-status', 'Listening...');
        return;
    }

    const isThem = source === 'system' || session.micTriggersAnswers;
    appendUserText(session, `[${isThem ? 'Them' : 'Me'}]: ${text}`);

    if (isThem) {
        answerAndRecord(session);
    } else if (!session.inflight) {
        sendToRenderer('update-status', 'Listening...');
    }
}

/**
 * Stream an answer for the current chat history. A newer request aborts an older one, and
 * the unanswered user text from the aborted request is merged into the new one.
 */
async function generateAnswer(session, { model = session.chatModel, userContentOverride = null } = {}) {
    session.inflight?.abort();
    const controller = new AbortController();
    session.inflight = controller;

    const history = trimChatHistory(session.chatHistory);
    const lastUser = history[history.length - 1];
    const promptText = lastUser?.role === 'user' ? lastUser.content : '';

    // The system prompt (with the knowledge base) is identical on every turn; mark it cacheable so
    // providers that need explicit breakpoints (Anthropic, Qwen) bill repeats at the cached rate.
    const systemContent =
        session.systemPrompt.length > CACHE_MIN_CHARS
            ? [{ type: 'text', text: session.systemPrompt, cache_control: { type: 'ephemeral' } }]
            : session.systemPrompt;
    const messages = [{ role: 'system', content: systemContent }, ...history];
    if (userContentOverride && lastUser?.role === 'user') {
        messages[messages.length - 1] = { role: 'user', content: userContentOverride };
    }

    sendToRenderer('update-status', 'Thinking...');
    logTransportEvent('api.chat.request', { provider: session.answerProvider, model, promptText });

    let isFirst = true;
    try {
        const { text, usage, finishReason } = await streamChat({
            provider: session.answerProvider,
            apiKey: session.keys[session.answerProvider],
            model,
            fallbackModels: fallbacksFor(session.answerProvider, model),
            messages,
            webSearch: session.webSearch,
            disableReasoning: session.disableReasoning,
            signal: controller.signal,
            onText: partial => {
                if (controller.signal.aborted || !partial) return;
                sendToRenderer(isFirst ? 'new-response' : 'update-response', partial);
                isFirst = false;
            },
        });

        addUsageCost(session, usage);
        logTransportEvent('api.chat.response', { model, text, usage, finishReason });

        if (controller.signal.aborted || !session.active) return null;

        if (!text) {
            sendToRenderer('new-response', `The model returned no answer (finish reason: ${finishReason || 'unknown'}). Try another model.`);
            sendToRenderer('update-status', 'Listening...');
            return null;
        }

        session.chatHistory.push({ role: 'assistant', content: text });
        if (session.chatHistory.length > MAX_HISTORY_MESSAGES * 2) {
            session.chatHistory = session.chatHistory.slice(-MAX_HISTORY_MESSAGES);
        }

        sendToRenderer('update-status', 'Listening...');
        return { text, promptText, model };
    } catch (error) {
        if (error.name === 'AbortError') return null;
        console.error('[API] Chat error:', error);
        logTransportEvent('api.chat.error', { error: error.message });
        sendToRenderer('update-status', 'Error: ' + error.message);
        if (isFirst) sendToRenderer('new-response', `**Error:** ${error.message}`);
        return null;
    } finally {
        if (session.inflight === controller) session.inflight = null;
    }
}

async function answerAndRecord(session, options) {
    const result = await generateAnswer(session, options);
    if (result) saveConversationTurn(result.promptText, result.text);
    return result;
}

async function initializeApiSession(profile = 'interview', customPrompt = '', language = 'en-US') {
    const config = getConfig();
    const setup = resolveProviderSetup(config);
    const needed = [...new Set([setup.answerProvider, setup.transcriptionProvider])];

    const keys = {};
    for (const provider of needed) {
        keys[provider] = getProviderApiKey(provider);
        if (!keys[provider]) {
            return { success: false, error: `Add your ${PROVIDERS[provider].label} API key first` };
        }
    }

    sendToRenderer('session-initializing', true);
    try {
        // Fail fast on a bad key instead of failing on the first utterance.
        await Promise.all(needed.map(provider => checkKey(provider, keys[provider])));

        closeApiSession();
        apiSession = createApiSession({
            keys,
            setup,
            config,
            preferences: getPreferences(),
            profile,
            customPrompt,
            language,
        });

        initializeNewSession(profile, customPrompt);
        currentProviderMode = 'api';
        sendToRenderer('update-status', 'Listening...');
        return { success: true };
    } catch (error) {
        console.error('[API] Session init error:', error);
        return { success: false, error: error.message };
    } finally {
        sendToRenderer('session-initializing', false);
    }
}

function closeApiSession() {
    if (!apiSession) return;
    apiSession.active = false;
    apiSession.inflight?.abort();
    apiSession = null;
}

function pushApiAudio(pcmBuffer, source) {
    apiSession?.segmenters[source]?.push(pcmBuffer);
}

async function sendApiText(text) {
    const session = apiSession;
    if (!session) return { success: false, error: 'No active session' };
    appendUserText(session, text);
    answerAndRecord(session);
    return { success: true };
}

async function sendApiImage(base64Data, prompt) {
    const session = apiSession;
    if (!session) return { success: false, error: 'No active session' };

    const promptText = prompt || 'Help me with what is on my screen.';
    appendUserText(session, `[Screenshot] ${promptText}`);
    const lastUser = session.chatHistory[session.chatHistory.length - 1];

    const result = await generateAnswer(session, {
        model: session.visionModel,
        userContentOverride: [
            { type: 'text', text: lastUser.content },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
        ],
    });

    if (!result) return { success: false, error: 'No response' };
    saveScreenAnalysis(promptText, result.text, result.model);
    return { success: true, text: result.text, model: result.model };
}

// ============ MACOS SYSTEM AUDIO ============

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', () => resolve());
        killProc.on('error', () => resolve());

        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

function routeAudio(pcmBuffer, source) {
    if (currentProviderMode === 'local') {
        getLocalAi().processLocalAudio(pcmBuffer);
    } else if (currentProviderMode === 'api') {
        pushApiAudio(pcmBuffer, source);
    }
}

async function startMacOSAudioCapture() {
    if (process.platform !== 'darwin') return false;

    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    const systemAudioPath = app.isPackaged
        ? path.join(process.resourcesPath, 'SystemAudioDump')
        : path.join(__dirname, '../assets', 'SystemAudioDump');

    systemAudioProc = spawn(systemAudioPath, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;
            routeAudio(monoChunk, 'system');

            if (process.env.DEBUG_AUDIO) {
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        monoBuffer.writeInt16LE(stereoBuffer.readInt16LE(i * 4), i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

// ============ SESSION LIFECYCLE ============

function closeActiveSession() {
    stopMacOSAudioCapture();

    if (currentProviderMode === 'local') {
        getLocalAi().closeLocalSession();
    }
    closeApiSession();

    currentProviderMode = null;
    closeTransportLog();
}

// ============ IPC ============

function setupSessionIpcHandlers() {
    ipcMain.handle('initialize-api', async (event, profile, customPrompt, language) => {
        closeActiveSession();
        return initializeApiSession(profile, customPrompt, language);
    });

    ipcMain.handle('initialize-local', async (event, localLlmModel, whisperModel, profile, customPrompt) => {
        closeActiveSession();
        currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(localLlmModel, whisperModel, profile, customPrompt);
        if (!success) {
            currentProviderMode = null;
        }
        return success;
    });

    ipcMain.handle('cancel-local-initialization', async () => {
        const cancelled = await getLocalAi().cancelLocalInitialization();
        if (cancelled) {
            currentProviderMode = null;
        }
        return cancelled;
    });

    const handleAudio =
        source =>
        async (event, { data }) => {
            try {
                if (typeof data !== 'string') return { success: false, error: 'Invalid audio data' };
                routeAudio(Buffer.from(data, 'base64'), source);
                return { success: true };
            } catch (error) {
                console.error(`Error handling ${source} audio:`, error);
                return { success: false, error: error.message };
            }
        };

    ipcMain.handle('send-audio-content', handleAudio('system'));
    ipcMain.handle('send-mic-audio-content', handleAudio('mic'));

    ipcMain.handle('send-image-content', async (event, { data, prompt }) => {
        try {
            if (!data || typeof data !== 'string') {
                return { success: false, error: 'Invalid image data' };
            }

            if (Buffer.byteLength(data, 'base64') < 1000) {
                return { success: false, error: 'Image buffer too small' };
            }

            if (currentProviderMode === 'local') {
                return await getLocalAi().sendLocalImage(data, prompt);
            }

            return await sendApiImage(data, prompt);
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        try {
            if (currentProviderMode === 'local') {
                return await getLocalAi().sendLocalText(text.trim());
            }
            return await sendApiText(text.trim());
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async () => {
        if (process.platform !== 'darwin') {
            return { success: false, error: 'macOS audio capture only available on macOS' };
        }

        try {
            return { success: await startMacOSAudioCapture() };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async () => {
        stopMacOSAudioCapture();
        return { success: true };
    });

    ipcMain.handle('close-session', async () => {
        try {
            closeActiveSession();
            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-current-session', async () => {
        return { success: true, data: getCurrentSessionData() };
    });

    ipcMain.handle('start-new-session', async () => {
        initializeNewSession();
        return { success: true, sessionId: currentSessionId };
    });

    ipcMain.handle('ai:providers', async () => ({ success: true, data: describeProviders() }));

    ipcMain.handle('ai:list-models', async (event, provider, kind) => {
        try {
            if (!PROVIDERS[provider]) throw new Error('Unknown provider');
            const apiKey = provider === 'openrouter' ? '' : getProviderApiKey(provider);
            return { success: true, data: await listModels({ provider, apiKey, kind: kind === 'transcription' ? 'transcription' : 'chat' }) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('ai:check-key', async (event, provider) => {
        try {
            if (!PROVIDERS[provider]) throw new Error('Unknown provider');
            return { success: true, data: await checkKey(provider, getProviderApiKey(provider)) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    setMainWindow,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    stopMacOSAudioCapture,
    closeActiveSession,
    setupSessionIpcHandlers,
};
