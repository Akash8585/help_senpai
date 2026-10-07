// Thin OpenRouter client: streaming chat completions, speech-to-text, and model listing.
// Docs: https://openrouter.ai/docs

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// Optional app attribution shown on openrouter.ai. Set APP_URL to your repo/site to enable it.
const APP_URL = '';
const APP_TITLE = 'Senpai';

function buildHeaders(apiKey) {
    const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': APP_TITLE,
    };
    if (APP_URL) headers['HTTP-Referer'] = APP_URL;
    return headers;
}

async function readErrorMessage(response) {
    const body = await response.text().catch(() => '');
    try {
        const parsed = JSON.parse(body);
        return parsed.error?.message || body;
    } catch {
        return body || response.statusText;
    }
}

class OpenRouterError extends Error {
    constructor(status, message) {
        super(`OpenRouter ${status}: ${message}`);
        this.name = 'OpenRouterError';
        this.status = status;
    }
}

/**
 * Stream a chat completion. Calls onText(fullTextSoFar) as tokens arrive.
 * Resolves with { text, usage, finishReason }.
 */
async function streamChat({ apiKey, model, messages, onText, webSearch = false, disableReasoning = true, maxTokens = 4096, signal }) {
    const body = {
        model,
        messages,
        stream: true,
        max_tokens: maxTokens,
        temperature: 0.7,
        usage: { include: true },
    };

    if (disableReasoning) {
        body.reasoning = { effort: 'none', exclude: true };
    } else {
        body.reasoning = { exclude: true };
    }

    if (webSearch) {
        body.plugins = [{ id: 'web', max_results: 3 }];
    }

    const send = () =>
        fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: buildHeaders(apiKey),
            body: JSON.stringify(body),
            signal,
        });

    let response = await send();

    // Models with mandatory reasoning reject effort "none"; retry once letting them think.
    if (response.status === 400 && disableReasoning) {
        const message = await readErrorMessage(response);
        if (!/reason/i.test(message)) throw new OpenRouterError(400, message);
        body.reasoning = { exclude: true };
        response = await send();
    }

    if (!response.ok || !response.body) {
        throw new OpenRouterError(response.status, await readErrorMessage(response));
    }

    const decoder = new TextDecoder();
    let pending = '';
    let text = '';
    let usage = null;
    let finishReason = null;

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
                throw new OpenRouterError(event.error.code || 'stream', event.error.message || 'Stream error');
            }

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

    return { text: stripThinkingTags(text), usage, finishReason };
}

/**
 * Transcribe a WAV buffer with an OpenRouter speech-to-text model.
 * Resolves with { text, usage }.
 */
async function transcribe({ apiKey, model, wavBuffer, language, signal }) {
    const body = {
        model,
        input_audio: {
            data: wavBuffer.toString('base64'),
            format: 'wav',
        },
        temperature: 0,
    };

    if (language) {
        body.language = language;
    }

    const response = await fetch(`${OPENROUTER_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        throw new OpenRouterError(response.status, await readErrorMessage(response));
    }

    const result = await response.json();
    return { text: (result.text || '').trim(), usage: result.usage || null };
}

/**
 * List models. Pass outputModality='transcription' to list speech-to-text models.
 */
async function listModels({ outputModality } = {}) {
    const url = new URL(`${OPENROUTER_BASE_URL}/models`);
    if (outputModality) url.searchParams.set('output_modalities', outputModality);

    const response = await fetch(url);
    if (!response.ok) {
        throw new OpenRouterError(response.status, await readErrorMessage(response));
    }

    const { data } = await response.json();
    return (data || []).map(model => ({
        id: model.id,
        name: model.name,
        inputModalities: model.architecture?.input_modalities || [],
        contextLength: model.context_length,
        pricing: model.pricing,
    }));
}

/**
 * Validate a key and return its credit info.
 */
async function getKeyInfo(apiKey) {
    const response = await fetch(`${OPENROUTER_BASE_URL}/key`, { headers: buildHeaders(apiKey) });
    if (!response.ok) {
        throw new OpenRouterError(response.status, await readErrorMessage(response));
    }
    const { data } = await response.json();
    return data;
}

function stripThinkingTags(text) {
    const trimmedStart = text.trimStart();
    if ('<think>'.startsWith(trimmedStart)) {
        return '';
    }
    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

module.exports = {
    OPENROUTER_BASE_URL,
    OpenRouterError,
    streamChat,
    transcribe,
    listModels,
    getKeyInfo,
    stripThinkingTags,
};
