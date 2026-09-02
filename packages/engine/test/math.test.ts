import { describe, it, expect } from 'vitest';
import { createRng } from '../src/math/rng.js';
import { sigmoid, logit, calibrateIntercept } from '../src/math/calibration.js';

describe('RngStream', () => {
  it('produces byte-identical sequences given identical seeds and stream keys', () => {
    const rng1 = createRng(42, 'member:1001:renew');
    const rng2 = createRng(42, 'member:1001:renew');

    for (let i = 0; i < 50; i++) {
      expect(rng1.next()).toBe(rng2.next());
    }
  });

  it('produces different sequences for different stream keys with the same seed', () => {
    const rng1 = createRng(42, 'streamA');
    const rng2 = createRng(42, 'streamB');

    expect(rng1.next()).not.toBe(rng2.next());
  });

  it('samples categorical options according to declared weights', () => {
    const rng = createRng(12345);
    const options = [
      { value: 'low', weight: 10 },
      { value: 'high', weight: 90 },
    ];

    let highCount = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) {
      if (rng.pickWeighted(options) === 'high') highCount++;
    }

    const empiricalRate = highCount / n;
    expect(empiricalRate).toBeGreaterThan(0.85);
    expect(empiricalRate).toBeLessThan(0.95);
  });
});

describe('Calibration Solver', () => {
  it('inverts sigmoid with logit', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 5);
    expect(logit(0.5)).toBeCloseTo(0, 5);
    expect(sigmoid(logit(0.85))).toBeCloseTo(0.85, 5);
  });

  it('numerically solves for beta0 to hit target rate on arbitrary scores', () => {
    const rng = createRng(99);
    const scores: number[] = [];
    for (let i = 0; i < 500; i++) {
      scores.push(rng.normal(0, 1.2));
    }

    const targetRate = 0.87; // Real-world More Cheese renewal target
    const b0 = calibrateIntercept(scores, targetRate);

    let sumProb = 0;
    for (const s of scores) {
      sumProb += sigmoid(b0 + s);
    }
    const empiricalMean = sumProb / scores.length;

    expect(empiricalMean).toBeCloseTo(targetRate, 4);
  });
});
