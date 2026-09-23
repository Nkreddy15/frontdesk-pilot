// G.711 mu-law on the Twilio side; little-endian signed PCM at 24 kHz for OpenAI.
export function decodeMuLaw(value: number) {
  const n = ~value & 255,
    sign = n & 128,
    exponent = (n >> 4) & 7,
    mantissa = n & 15;
  const sample = ((mantissa << 3) + 132) * (1 << exponent) - 132;
  return sign ? -sample : sample;
}
export function encodeMuLaw(sample: number) {
  let value = Math.round(Math.max(-32635, Math.min(32635, sample))),
    sign = 0;
  if (value < 0) {
    sign = 128;
    value = -value;
  }
  value += 132;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (value >> (exponent + 3)) & 15;
  return ~(sign | (exponent << 4) | mantissa) & 255;
}
export class AudioInput {
  private previous = 0;
  convert(muLaw: Buffer) {
    const output = Buffer.alloc(muLaw.length * 6);
    for (let i = 0; i < muLaw.length; i++) {
      const sample = decodeMuLaw(muLaw[i]);
      for (let j = 0; j < 3; j++)
        output.writeInt16LE(
          Math.round(this.previous + ((sample - this.previous) * (j + 1)) / 3),
          (i * 3 + j) * 2,
        );
      this.previous = sample;
    }
    return output;
  }
}
const taps = 63,
  cutoff = 3400 / 24000;
const filter = Array.from({ length: taps }, (_, i) => {
  const k = i - (taps - 1) / 2;
  return (
    (k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k)) *
    (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)))
  );
});
const total = filter.reduce((a, b) => a + b, 0);
for (let i = 0; i < taps; i++) filter[i] /= total;
export function pcm24ToMuLaw8(pcm: Buffer) {
  const samples = Math.floor(pcm.length / 2),
    out = Buffer.alloc(Math.floor(samples / 3));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const at = i * 3 + j - (taps - 1) / 2;
      if (at >= 0 && at < samples) sum += pcm.readInt16LE(at * 2) * filter[j];
    }
    out[i] = encodeMuLaw(sum);
  }
  return out;
}
// Completion events can arrive out of order. Process only the head committed turn.
export class TranscriptOrder {
  private order: string[] = [];
  private completed = new Map<string, string>();
  private seen = new Set<string>();
  commit(id: string) {
    if (!this.seen.has(id)) {
      this.seen.add(id);
      this.order.push(id);
    }
  }
  complete(id: string, text: string) {
    this.completed.set(id, text);
  }
  drain() {
    const result: { id: string; text: string }[] = [];
    while (this.order.length && this.completed.has(this.order[0])) {
      const id = this.order.shift()!;
      result.push({ id, text: this.completed.get(id)! });
      this.completed.delete(id);
    }
    return result;
  }
}
