// Session orchestration: owns the active provider (OpenRouter or local AI), routes captured
// audio / screenshots / typed text to it, and records conversation history.
//
// OpenRouter pipeline:
//   PCM audio -> speechSegmenter (VAD) -> /audio/transcriptions -> chat completions (streamed) -> renderer

const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const { getOpenRouterApiKey, getConfig, getPreferences } = require('../storage');
const { streamChat, transcribe, listModels, getKeyInfo } = require('./openrouter');
const { createSpeechSegmenter, createWavBuffer } = require('./speechSegmenter');
const { startTransportLog, logTransportEvent, closeTransportLog } = require('./transportLogger');
const { buildKnowledgeSection } = require('./knowledge');

// Lazy-loaded to avoid circular dependency (localai.js imports from session.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

// Provider mode: 'openrouter' or 'local'. null when no session is running.
let currentProviderMode = null;

// Conversation tracking (persisted to history)
let currentSessionId = null;
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;

// OpenRouter session state
let openRouterSession = null;

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

function createOpenRouterSession({ apiKey, config, preferences, profile, customPrompt, language }) {
    const webSearch = preferences.webSearchEnabled === true;
    const audioMode = preferences.audioMode || 'speaker_only';

    const session = {
        apiKey,
        chatModel: config.openrouterModel,
        visionModel: config.openrouterVisionModel || config.openrouterModel,
        transcriptionModel: config.openrouterTranscriptionModel,
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
        .catch(error => console.error('[OpenRouter] Utterance handling error:', error));
}

async function handleUtterance(session, source, pcm16k) {
    if (!session.active) return;

    if (!session.inflight) sendToRenderer('update-status', 'Transcribing...');
    logTransportEvent('openrouter.stt.request', { model: session.transcriptionModel, source, bytes: pcm16k.length });

    let text;
    try {
        const result = await transcribe({
            apiKey: session.apiKey,
            model: session.transcriptionModel,
            wavBuffer: createWavBuffer(pcm16k),
            language: session.language,
        });
        text = result.text;
        addUsageCost(session, result.usage);
        logTransportEvent('openrouter.stt.response', { source, text, usage: result.usage });
    } catch (error) {
        console.error('[OpenRouter] Transcription error:', error);
        logTransportEvent('openrouter.stt.error', { error: error.message });
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
    logTransportEvent('openrouter.chat.request', { model, promptText });

    let isFirst = true;
    try {
        const { text, usage, finishReason } = await streamChat({
            apiKey: session.apiKey,
            model,
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
        logTransportEvent('openrouter.chat.response', { model, text, usage, finishReason });

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
        console.error('[OpenRouter] Chat error:', error);
        logTransportEvent('openrouter.chat.error', { error: error.message });
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

async function initializeOpenRouterSession(profile = 'interview', customPrompt = '', language = 'en-US') {
    const apiKey = getOpenRouterApiKey();
    if (!apiKey) {
        return { success: false, error: 'Add your OpenRouter API key first' };
    }

    sendToRenderer('session-initializing', true);
    try {
        // Fail fast on a bad key instead of failing on the first utterance.
        await getKeyInfo(apiKey);

        closeOpenRouterSession();
        openRouterSession = createOpenRouterSession({
            apiKey,
            config: getConfig(),
            preferences: getPreferences(),
            profile,
            customPrompt,
            language,
        });

        initializeNewSession(profile, customPrompt);
        currentProviderMode = 'openrouter';
        sendToRenderer('update-status', 'Listening...');
        return { success: true };
    } catch (error) {
        console.error('[OpenRouter] Session init error:', error);
        return { success: false, error: error.message };
    } finally {
        sendToRenderer('session-initializing', false);
    }
}

function closeOpenRouterSession() {
    if (!openRouterSession) return;
    openRouterSession.active = false;
    openRouterSession.inflight?.abort();
    openRouterSession = null;
}

function pushOpenRouterAudio(pcmBuffer, source) {
    openRouterSession?.segmenters[source]?.push(pcmBuffer);
}

async function sendOpenRouterText(text) {
    const session = openRouterSession;
    if (!session) return { success: false, error: 'No active session' };
    appendUserText(session, text);
    answerAndRecord(session);
    return { success: true };
}

async function sendOpenRouterImage(base64Data, prompt) {
    const session = openRouterSession;
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
    } else if (currentProviderMode === 'openrouter') {
        pushOpenRouterAudio(pcmBuffer, source);
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
    closeOpenRouterSession();

    currentProviderMode = null;
    closeTransportLog();
}

// ============ IPC ============

function setupSessionIpcHandlers() {
    ipcMain.handle('initialize-openrouter', async (event, profile, customPrompt, language) => {
        closeActiveSession();
        return initializeOpenRouterSession(profile, customPrompt, language);
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

            return await sendOpenRouterImage(data, prompt);
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
            return await sendOpenRouterText(text.trim());
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

    ipcMain.handle('openrouter:list-models', async (event, outputModality) => {
        try {
            return { success: true, data: await listModels({ outputModality }) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('openrouter:key-info', async () => {
        try {
            const apiKey = getOpenRouterApiKey();
            if (!apiKey) return { success: false, error: 'No API key' };
            return { success: true, data: await getKeyInfo(apiKey) };
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
