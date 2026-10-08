// AI providers Senpai can call over HTTP. All three speak (mostly) the OpenAI wire format:
//   - OpenRouter: any model, paid or ":free"; chat, vision and speech-to-text
//   - Google Gemini (OpenAI-compatible endpoint): free tier; chat, vision, and audio via chat
//   - Groq: free tier; Whisper speech-to-text
// Docs: openrouter.ai/docs, ai.google.dev/gemini-api/docs/openai, console.groq.com/docs/speech-to-text

const APP_TITLE = 'Help Senpai';
// Optional app attribution shown on openrouter.ai. Set to your repo/site to enable it.
const APP_URL = '';

const PROVIDERS = {
    openrouter: {
        id: 'openrouter',
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        keyUrl: 'https://openrouter.ai/keys',
        keyPlaceholder: 'sk-or-...',
        chat: true,
        transcription: true,
        defaults: { chatModel: 'google/gemini-3.8-flash', transcriptionModel: 'openai/whisper-large-v3-turbo' },
    },
    gemini: {
        id: 'gemini',
        label: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        keyUrl: 'https://aistudio.google.com/apikey',
        keyPlaceholder: 'AIza...',
        free: true,
        chat: true,
        transcription: true,
        defaults: { chatModel: 'gemini-3.8-flash', transcriptionModel: 'gemini-3.8-flash' },
    },
    groq: {
        id: 'groq',
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        keyUrl: 'https://console.groq.com/keys',
        keyPlaceholder: 'gsk_...',
        free: true,
        chat: false,
        transcription: true,
        defaults: { transcriptionModel: 'whisper-large-v3-turbo' },
    },
};

class ProviderError extends Error {
    constructor(provider, status, message, { retryAfter } = {}) {
        const label = PROVIDERS[provider]?.label || provider;
        const friendly =
            status === 429
                ? `${label} rate limit reached${retryAfter ? ` (retry in ${retryAfter}s)` : ''}. Free tiers allow a limited number of requests per minute and per day. ${message}`
                : status === 401 || status === 403 || /api[ _-]?key/i.test(message)
                  ? `${label} rejected the API key. ${message}`
                  : `${label} ${status}: ${message}`;
        super(friendly.trim());
        this.name = 'ProviderError';
        this.provider = provider;
        this.status = status;
    }
}

function getProvider(id) {
    const provider = PROVIDERS[id];
    if (!provider) throw new Error(`Unknown AI provider: ${id}`);
    return provider;
}

function buildHeaders(providerId, apiKey, json = true) {
    const headers = { Authorization: `Bearer ${apiKey}` };
    if (json) headers['Content-Type'] = 'application/json';
    if (providerId === 'openrouter') {
        headers['X-Title'] = APP_TITLE;
        if (APP_URL) headers['HTTP-Referer'] = APP_URL;
    }
    return headers;
}

async function readError(providerId, response) {
    const body = await response.text().catch(() => '');
    let message = body || response.statusText;
    try {
        const parsed = JSON.parse(body);
        const error = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
        message = error?.message || message;
    } catch {
        // keep raw text
    }
    return new ProviderError(providerId, response.status, String(message).slice(0, 400), { retryAfter: response.headers.get('retry-after') });
}

function stripThinkingTags(text) {
    const trimmedStart = text.trimStart();
    if ('<think>'.startsWith(trimmedStart)) {
        return '';
    }
    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

/** Gemini and Groq expect plain-string system content; OpenRouter accepts content parts with cache_control. */
function normalizeMessages(providerId, messages) {
    if (providerId === 'openrouter') return messages;
    return messages.map(message =>
        message.role === 'system' && Array.isArray(message.content)
            ? { ...message, content: message.content.map(part => part.text || '').join('\n') }
            : message
    );
}

function buildChatBody(providerId, { model, fallbackModels, messages, webSearch, disableReasoning, maxTokens, stream }) {
    const body = { model, messages: normalizeMessages(providerId, messages), stream, max_tokens: maxTokens, temperature: 0.7 };

    if (providerId === 'openrouter') {
        body.usage = { include: true };
        body.reasoning = disableReasoning ? { effort: 'none', exclude: true } : { exclude: true };
        if (webSearch) body.plugins = [{ id: 'web', max_results: 3 }];
        if (fallbackModels?.length) body.models = fallbackModels;
    } else if (providerId === 'gemini' && disableReasoning) {
        // Gemini 3 models cannot turn thinking off entirely; "minimal" is the fastest setting.
        body.reasoning_effort = 'minimal';
    }

    return body;
}

async function postChat(providerId, apiKey, body, signal) {
    const provider = getProvider(providerId);
    const send = payload =>
        fetch(`${provider.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: buildHeaders(providerId, apiKey),
            body: JSON.stringify(payload),
            signal,
        });

    let response = await send(body);

    // Some models reject the reasoning setting; retry once without it.
    if (response.status === 400 && (body.reasoning || body.reasoning_effort)) {
        const error = await readError(providerId, response);
        if (!/reason|thinking|effort/i.test(error.message)) throw error;
        const { reasoning, reasoning_effort, ...rest } = body;
        response = await send(providerId === 'openrouter' ? { ...rest, reasoning: { exclude: true } } : rest);
    }

    if (!response.ok) throw await readError(providerId, response);
    return response;
}

/**
 * Stream a chat completion. Calls onText(fullTextSoFar) as tokens arrive.
 * Resolves with { text, usage, finishReason, model }.
 */
async function streamChat({
    provider: providerId = 'openrouter',
    apiKey,
    model,
    fallbackModels,
    messages,
    onText,
    webSearch = false,
    disableReasoning = true,
    maxTokens = 4096,
    signal,
}) {
    const body = buildChatBody(providerId, { model, fallbackModels, messages, webSearch, disableReasoning, maxTokens, stream: true });
    const response = await postChat(providerId, apiKey, body, signal);
    if (!response.body) throw new ProviderError(providerId, response.status, 'Empty response');

    const decoder = new TextDecoder();
    let pending = '';
    let text = '';
    let usage = null;
    let finishReason = null;
    let usedModel = model;

    for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            // Lines starting with ':' are SSE comments (OpenRouter sends ": OPENROUTER PROCESSING" keep-alives)
            if (!line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;

            let event;
            try {
                event = JSON.parse(data);
            } catch {
                continue;
            }

            if (event.error) {
                throw new ProviderError(providerId, event.error.code || 'stream', event.error.message || 'Stream error');
            }

            if (event.model) usedModel = event.model;
            if (event.usage) usage = event.usage;
            const choice = event.choices?.[0];
            if (!choice) continue;
            finishReason = choice.finish_reason || finishReason;

            const token = choice.delta?.content || '';
            if (token) {
                text += token;
                onText?.(stripThinkingTags(text));
            }
        }
    }

    return { text: stripThinkingTags(text), usage, finishReason, model: usedModel };
}

function languageName(code) {
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
    } catch {
        return code;
    }
}

/**
 * Transcribe a 16 kHz mono WAV buffer. Resolves with { text, usage }.
 */
async function transcribe({ provider: providerId = 'openrouter', apiKey, model, wavBuffer, language, signal }) {
    const provider = getProvider(providerId);

    if (providerId === 'openrouter') {
        const body = { model, input_audio: { data: wavBuffer.toString('base64'), format: 'wav' }, temperature: 0 };
        if (language) body.language = language;
        const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: buildHeaders(providerId, apiKey),
            body: JSON.stringify(body),
            signal,
        });
        if (!response.ok) throw await readError(providerId, response);
        const result = await response.json();
        return { text: (result.text || '').trim(), usage: result.usage || null };
    }

    if (providerId === 'groq') {
        const form = new FormData();
        form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
        form.append('model', model);
        form.append('response_format', 'json');
        form.append('temperature', '0');
        if (language) form.append('language', language);
        const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: buildHeaders(providerId, apiKey, false),
            body: form,
            signal,
        });
        if (!response.ok) throw await readError(providerId, response);
        const result = await response.json();
        return { text: (result.text || '').trim(), usage: null };
    }

    if (providerId === 'gemini') {
        // Gemini's OpenAI-compatible API has no transcription endpoint; send the audio to a chat model.
        const instruction = `Transcribe the speech in this audio exactly as spoken${language ? ` (${languageName(language)})` : ''}. Reply with only the transcript text. If there is no intelligible speech, reply with nothing.`;
        const body = {
            model,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: instruction },
                        { type: 'input_audio', input_audio: { data: wavBuffer.toString('base64'), format: 'wav' } },
                    ],
                },
            ],
            temperature: 0,
            reasoning_effort: 'minimal',
        };
        const response = await postChat(providerId, apiKey, body, signal);
        const result = await response.json();
        return { text: (result.choices?.[0]?.message?.content || '').trim(), usage: null };
    }

    throw new Error(`${provider.label} does not support transcription`);
}

/**
 * List models. OpenRouter needs no key; Gemini and Groq do.
 * kind: 'chat' | 'transcription'
 */
async function listModels({ provider: providerId = 'openrouter', apiKey, kind = 'chat' } = {}) {
    const provider = getProvider(providerId);

    if (providerId === 'openrouter') {
        const url = new URL(`${provider.baseUrl}/models`);
        if (kind === 'transcription') url.searchParams.set('output_modalities', 'transcription');
        const response = await fetch(url);
        if (!response.ok) throw await readError(providerId, response);
        const { data } = await response.json();
        return (data || []).map(model => ({
            id: model.id,
            name: model.name,
            inputModalities: model.architecture?.input_modalities || [],
            contextLength: model.context_length,
            pricing: model.pricing,
            free: Number(model.pricing?.prompt) === 0 && Number(model.pricing?.completion) === 0,
        }));
    }

    if (!apiKey) return [];
    const response = await fetch(`${provider.baseUrl}/models`, { headers: buildHeaders(providerId, apiKey, false) });
    if (!response.ok) throw await readError(providerId, response);
    const { data } = await response.json();
    const models = (data || []).map(model => {
        const id = String(model.id).replace(/^models\//, '');
        return { id, name: model.display_name || id, inputModalities: [], free: Boolean(provider.free) };
    });

    const isSpeech = model => /whisper|transcribe|asr/i.test(model.id);
    if (providerId === 'groq') return kind === 'transcription' ? models.filter(isSpeech) : [];
    // Gemini: chat models (Gemini/Gemma), excluding embedding, image, video and TTS variants.
    return models.filter(model => /^(gemini|gemma)/i.test(model.id) && !/embedding|image|veo|imagen|tts|robotics|lyria/i.test(model.id));
}

/** Validate an API key. Resolves with { ok, detail }. */
async function checkKey(providerId, apiKey) {
    const provider = getProvider(providerId);
    if (!apiKey) return { ok: false, detail: 'No API key' };

    if (providerId === 'openrouter') {
        const response = await fetch(`${provider.baseUrl}/key`, { headers: buildHeaders(providerId, apiKey, false) });
        if (!response.ok) throw await readError(providerId, response);
        const { data } = await response.json();
        const remaining = data?.limit_remaining;
        const detail = Number.isFinite(remaining) ? `$${remaining.toFixed(2)} credit left` : `$${(data?.usage || 0).toFixed(2)} used`;
        return { ok: true, detail };
    }

    const response = await fetch(`${provider.baseUrl}/models`, { headers: buildHeaders(providerId, apiKey, false) });
    if (!response.ok) throw await readError(providerId, response);
    return { ok: true, detail: provider.free ? 'free tier' : '' };
}

/** Public provider metadata for the UI. */
function describeProviders() {
    return Object.values(PROVIDERS).map(({ id, label, keyUrl, keyPlaceholder, free, chat, transcription, defaults }) => ({
        id,
        label,
        keyUrl,
        keyPlaceholder,
        free: Boolean(free),
        chat,
        transcription,
        defaults,
    }));
}

module.exports = {
    PROVIDERS,
    ProviderError,
    getProvider,
    streamChat,
    transcribe,
    listModels,
    checkKey,
    describeProviders,
    stripThinkingTags,
};
