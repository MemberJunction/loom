/**
 * Deterministic PRNG with named stream support.
 * Uses 32-bit FNV-1a hashing for stream keys combined with Mulberry32 generator.
 */

export class RngStream {
  private state: number;

  constructor(seed: number, streamKey?: string) {
    let combinedSeed = seed >>> 0;
    if (streamKey) {
      combinedSeed = (combinedSeed ^ hashString(streamKey)) >>> 0;
    }
    this.state = combinedSeed || 0xdeadbeef;
  }

  /** Returns deterministic float in [0, 1) */
  public next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Bernoulli draw with probability p in [0, 1] */
  public bernoulli(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }

  /** Uniform integer draw in [min, max] inclusive */
  public int(min: number, max: number): number {
    const low = Math.ceil(min);
    const high = Math.floor(max);
    return Math.floor(this.next() * (high - low + 1)) + low;
  }

  /** Normal (Gaussian) draw using Box-Muller transform */
  public normal(mean = 0, stdDev = 1): number {
    const u1 = Math.max(1e-15, this.next());
    const u2 = this.next();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z0 * stdDev;
  }

  /** Randomly pick one element from non-empty array */
  public pick<T>(array: readonly T[]): T {
    if (array.length === 0) {
      throw new Error('RngStream.pick: array must not be empty');
    }
    const idx = Math.floor(this.next() * array.length);
    const chosen = array[idx];
    if (chosen === undefined) {
      throw new Error(`RngStream.pick: index ${idx} out of bounds`);
    }
    return chosen;
  }

  /** Pick one element using weighted categorical distribution */
  public pickWeighted<T>(options: readonly { value: T; weight: number }[]): T {
    if (options.length === 0) {
      throw new Error('RngStream.pickWeighted: options must not be empty');
    }
    const totalWeight = options.reduce((sum, opt) => sum + opt.weight, 0);
    if (totalWeight <= 0) {
      throw new Error('RngStream.pickWeighted: total weight must be positive');
    }
    let threshold = this.next() * totalWeight;
    for (const opt of options) {
      threshold -= opt.weight;
      if (threshold <= 0) {
        return opt.value;
      }
    }
    const last = options[options.length - 1];
    if (!last) throw new Error('RngStream.pickWeighted: options array is empty');
    return last.value;
  }

  /** Deterministic array shuffle (Fisher-Yates) */
  public shuffle<T>(array: readonly T[]): T[] {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const temp = copy[i];
      const target = copy[j];
      if (temp !== undefined && target !== undefined) {
        copy[i] = target;
        copy[j] = temp;
      }
    }
    return copy;
  }

  /** Derives an isolated child named stream */
  public substream(streamKey: string): RngStream {
    return new RngStream(this.state, streamKey);
  }
}

/** 32-bit FNV-1a hash */
function hashString(str: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** Helper to instantiate an RngStream */
export function createRng(seed: number, streamKey?: string): RngStream {
  return new RngStream(seed, streamKey);
}
