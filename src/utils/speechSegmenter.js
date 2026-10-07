// Energy-based voice activity detection that turns a stream of 24 kHz PCM16 mono
// chunks into discrete 16 kHz WAV utterances. Shared by the OpenRouter and local AI pipelines.

const VAD_MODES = {
    NORMAL: { energyThreshold: 0.01, speechFramesRequired: 3, silenceFramesRequired: 30 },
    LOW_BITRATE: { energyThreshold: 0.008, speechFramesRequired: 4, silenceFramesRequired: 35 },
    AGGRESSIVE: { energyThreshold: 0.015, speechFramesRequired: 2, silenceFramesRequired: 20 },
    VERY_AGGRESSIVE: { energyThreshold: 0.02, speechFramesRequired: 2, silenceFramesRequired: 15 },
};

const OUTPUT_SAMPLE_RATE = 16000;
// Force a flush during very long monologues so transcription keeps up.
const MAX_SEGMENT_SECONDS = 30;
// Ignore blips shorter than this.
const MIN_SEGMENT_BYTES = OUTPUT_SAMPLE_RATE * 2 * 0.5;
// Keep a little audio from before speech was confirmed so first syllables are not clipped.
const PRE_ROLL_FRAMES = 3;
const TRAILING_SILENCE_FRAMES = 3;

function calculateRms(pcm16Buffer) {
    const samples = Math.floor(pcm16Buffer.length / 2);
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}

function createWavBuffer(pcm16Buffer, sampleRate = OUTPUT_SAMPLE_RATE) {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * 2;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm16Buffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm16Buffer.length, 40);

    return Buffer.concat([header, pcm16Buffer]);
}

/**
 * @param {object} options
 * @param {(pcm16k: Buffer) => void} options.onSegment  called with raw 16 kHz PCM16 for each utterance
 * @param {() => void} [options.onSpeechStart]
 * @param {keyof VAD_MODES} [options.mode]
 */
function createSpeechSegmenter({ onSegment, onSpeechStart, mode = 'VERY_AGGRESSIVE' }) {
    const vadConfig = VAD_MODES[mode] || VAD_MODES.VERY_AGGRESSIVE;
    const maxSegmentBytes = OUTPUT_SAMPLE_RATE * 2 * MAX_SEGMENT_SECONDS;

    let isSpeaking = false;
    let speechBuffers = [];
    let speechBytes = 0;
    let preRoll = [];
    let silenceFrameCount = 0;
    let speechFrameCount = 0;
    let resampleRemainder = Buffer.alloc(0);

    function resample24kTo16k(inputBuffer) {
        const combined = Buffer.concat([resampleRemainder, inputBuffer]);
        const inputSamples = Math.floor(combined.length / 2);
        const outputSamples = Math.floor((inputSamples * 2) / 3);
        const outputBuffer = Buffer.alloc(outputSamples * 2);

        for (let i = 0; i < outputSamples; i++) {
            const sourcePosition = (i * 3) / 2;
            const sourceIndex = Math.floor(sourcePosition);
            const fraction = sourcePosition - sourceIndex;
            const firstSample = combined.readInt16LE(sourceIndex * 2);
            const secondSample = sourceIndex + 1 < inputSamples ? combined.readInt16LE((sourceIndex + 1) * 2) : firstSample;
            const interpolated = Math.round(firstSample + fraction * (secondSample - firstSample));
            outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
        }

        const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
        const remainderStart = consumedInputSamples * 2;
        resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

        return outputBuffer;
    }

    function flush() {
        const audio = Buffer.concat(speechBuffers);
        speechBuffers = [];
        speechBytes = 0;
        if (audio.length >= MIN_SEGMENT_BYTES) {
            onSegment(audio);
        }
    }

    function processFrame(pcm16k) {
        const isVoice = calculateRms(pcm16k) > vadConfig.energyThreshold;

        if (isVoice) {
            speechFrameCount += 1;
            silenceFrameCount = 0;

            if (!isSpeaking && speechFrameCount >= vadConfig.speechFramesRequired) {
                isSpeaking = true;
                speechBuffers = [...preRoll];
                speechBytes = speechBuffers.reduce((sum, b) => sum + b.length, 0);
                onSpeechStart?.();
            }
        } else {
            silenceFrameCount += 1;
            speechFrameCount = 0;

            if (isSpeaking && silenceFrameCount >= vadConfig.silenceFramesRequired) {
                isSpeaking = false;
                // Drop the trailing silence (keeping a short tail) so STT is not billed for it.
                const trailingSilentFrames = Math.min(speechBuffers.length, Math.max(0, silenceFrameCount - 1 - TRAILING_SILENCE_FRAMES));
                speechBuffers.splice(speechBuffers.length - trailingSilentFrames, trailingSilentFrames);
                flush();
                return;
            }
        }

        if (isSpeaking) {
            speechBuffers.push(pcm16k);
            speechBytes += pcm16k.length;
            if (speechBytes >= maxSegmentBytes) {
                flush();
            }
        } else {
            preRoll.push(pcm16k);
            if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
        }
    }

    return {
        /** Feed a 24 kHz PCM16 mono chunk. */
        push(pcm24kMono) {
            const pcm16k = resample24kTo16k(pcm24kMono);
            if (pcm16k.length > 0) processFrame(pcm16k);
        },
        reset() {
            isSpeaking = false;
            speechBuffers = [];
            speechBytes = 0;
            preRoll = [];
            silenceFrameCount = 0;
            speechFrameCount = 0;
            resampleRemainder = Buffer.alloc(0);
        },
    };
}

module.exports = {
    VAD_MODES,
    OUTPUT_SAMPLE_RATE,
    calculateRms,
    createWavBuffer,
    createSpeechSegmenter,
};
