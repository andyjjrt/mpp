import { RuntimeError } from '../utils/errors.js';

export const DEFAULT_NORMALIZED_SAMPLE_RATE = 16_000;
export const PCM16_BITS_PER_SAMPLE = 16;
export const PCM16_BYTES_PER_SAMPLE = PCM16_BITS_PER_SAMPLE / 8;
export const PCM16_MONO_CHANNELS = 1;
export const WAV_HEADER_SIZE = 44;

export interface NormalizePcmToWavInput {
  pcm: Buffer | Int16Array;
  sampleRate: number;
  channels?: number;
  targetSampleRate?: number;
}

export interface NormalizedWavAudio {
  buffer: Buffer;
  data: Buffer;
  sampleCount: number;
  durationMs: number;
  sampleRate: number;
  channels: 1;
  bitsPerSample: 16;
  byteRate: number;
  blockAlign: number;
  dataSize: number;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RuntimeError(`${name} must be a positive integer`);
  }

  return value;
}

function clampPcm16Sample(value: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}

function readPcm16Samples(buffer: Buffer): Int16Array {
  if (!Buffer.isBuffer(buffer)) {
    throw new RuntimeError('pcm must be a Buffer or Int16Array');
  }

  if (buffer.length % PCM16_BYTES_PER_SAMPLE !== 0) {
    throw new RuntimeError('pcm Buffer length must align to 16-bit samples');
  }

  const sampleCount = buffer.length / PCM16_BYTES_PER_SAMPLE;
  const samples = new Int16Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = buffer.readInt16LE(index * PCM16_BYTES_PER_SAMPLE);
  }

  return samples;
}

function writePcm16Samples(samples: Int16Array): Buffer {
  const buffer = Buffer.alloc(samples.length * PCM16_BYTES_PER_SAMPLE);

  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], index * PCM16_BYTES_PER_SAMPLE);
  }

  return buffer;
}

function resolveInputSamples(pcm: Buffer | Int16Array): Int16Array {
  if (pcm instanceof Int16Array) {
    return Int16Array.from(pcm, clampPcm16Sample);
  }

  return readPcm16Samples(pcm);
}

function mixToMono(samples: Int16Array, channels: number): Int16Array {
  if (channels === PCM16_MONO_CHANNELS) {
    return Int16Array.from(samples);
  }

  if (samples.length % channels !== 0) {
    throw new RuntimeError('pcm sample count must divide evenly across channels');
  }

  const frameCount = samples.length / channels;
  const monoSamples = new Int16Array(frameCount);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    let mixedSample = 0;

    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      mixedSample += samples[(frameIndex * channels) + channelIndex];
    }

    monoSamples[frameIndex] = clampPcm16Sample(mixedSample / channels);
  }

  return monoSamples;
}

function resampleMonoPcm16(samples: Int16Array, sourceSampleRate: number, targetSampleRate: number): Int16Array {
  if (samples.length === 0) {
    return new Int16Array(0);
  }

  if (sourceSampleRate === targetSampleRate) {
    return Int16Array.from(samples);
  }

  const outputSampleCount = Math.max(1, Math.round((samples.length * targetSampleRate) / sourceSampleRate));
  const output = new Int16Array(outputSampleCount);
  const rateRatio = sourceSampleRate / targetSampleRate;

  for (let outputIndex = 0; outputIndex < outputSampleCount; outputIndex += 1) {
    const sourceIndex = outputIndex * rateRatio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, samples.length - 1);
    const interpolation = sourceIndex - leftIndex;
    const leftSample = samples[leftIndex] ?? samples[samples.length - 1] ?? 0;
    const rightSample = samples[rightIndex] ?? leftSample;
    output[outputIndex] = clampPcm16Sample(
      leftSample + ((rightSample - leftSample) * interpolation),
    );
  }

  return output;
}

function createWavHeader(dataSize: number, sampleRate: number): Buffer {
  const blockAlign = PCM16_MONO_CHANNELS * PCM16_BYTES_PER_SAMPLE;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_SIZE);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(PCM16_MONO_CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(PCM16_BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return header;
}

export function normalizePcmToWav(input: NormalizePcmToWavInput): NormalizedWavAudio {
  const sourceSampleRate = requirePositiveInteger('sampleRate', input.sampleRate);
  const channelCount = requirePositiveInteger('channels', input.channels ?? PCM16_MONO_CHANNELS);
  const targetSampleRate = requirePositiveInteger(
    'targetSampleRate',
    input.targetSampleRate ?? DEFAULT_NORMALIZED_SAMPLE_RATE,
  );
  const sourceSamples = resolveInputSamples(input.pcm);
  const monoSamples = mixToMono(sourceSamples, channelCount);
  const normalizedSamples = resampleMonoPcm16(monoSamples, sourceSampleRate, targetSampleRate);
  const data = writePcm16Samples(normalizedSamples);
  const header = createWavHeader(data.length, targetSampleRate);
  const buffer = Buffer.concat([header, data], header.length + data.length);
  const blockAlign = PCM16_MONO_CHANNELS * PCM16_BYTES_PER_SAMPLE;
  const byteRate = targetSampleRate * blockAlign;

  return {
    buffer,
    data,
    sampleCount: normalizedSamples.length,
    durationMs: normalizedSamples.length === 0
      ? 0
      : Math.round((normalizedSamples.length / targetSampleRate) * 1_000),
    sampleRate: targetSampleRate,
    channels: PCM16_MONO_CHANNELS,
    bitsPerSample: PCM16_BITS_PER_SAMPLE,
    byteRate,
    blockAlign,
    dataSize: data.length,
  };
}
