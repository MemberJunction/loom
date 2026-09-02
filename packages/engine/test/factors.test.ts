import { describe, it, expect } from 'vitest';
import { FactorEngine } from '../src/factors/engine.js';
import { createRng } from '../src/math/rng.js';

describe('FactorEngine with Cholesky Decomposition', () => {
  it('correctly maintains target mean, standard deviation, and correlation', () => {
    const engine = new FactorEngine();

    engine.RegisterDial({
      name: 'income',
      mean: 50,
      stdDev: 10,
      annualWanderStdDev: 1,
      correlations: { spending: 0.6 },
    });

    engine.RegisterDial({
      name: 'spending',
      mean: 30,
      stdDev: 5,
      annualWanderStdDev: 0.5,
      correlations: { income: 0.6 }, // Bidirectional declaration should not double-apply
    });

    const rng = createRng(42);
    const n = 2000;
    const incomes: number[] = [];
    const spendings: number[] = [];

    for (let i = 0; i < n; i++) {
      const profile = engine.InitializeProfile(rng, `entity-${i}`);
      incomes.push(profile.dials['income']!);
      spendings.push(profile.dials['spending']!);
    }

    // 1. Mean check
    const meanIncome = incomes.reduce((a, b) => a + b, 0) / n;
    const meanSpending = spendings.reduce((a, b) => a + b, 0) / n;
    expect(meanIncome).toBeCloseTo(50, 0); // e.g. 49.8
    expect(meanSpending).toBeCloseTo(30, 0);

    // 2. StdDev check
    const varianceIncome = incomes.reduce((a, b) => a + Math.pow(b - meanIncome, 2), 0) / n;
    const stdDevIncome = Math.sqrt(varianceIncome);
    expect(stdDevIncome).toBeGreaterThan(9.3);
    expect(stdDevIncome).toBeLessThan(10.7);

    const varianceSpending = spendings.reduce((a, b) => a + Math.pow(b - meanSpending, 2), 0) / n;
    const stdDevSpending = Math.sqrt(varianceSpending);
    expect(stdDevSpending).toBeGreaterThan(4.5);
    expect(stdDevSpending).toBeLessThan(5.5);

    // 3. Pearson Correlation check
    let covariance = 0;
    for (let i = 0; i < n; i++) {
      covariance += (incomes[i]! - meanIncome) * (spendings[i]! - meanSpending);
    }
    covariance /= n;
    const correlation = covariance / (stdDevIncome * stdDevSpending);

    expect(correlation).toBeGreaterThan(0.55);
    expect(correlation).toBeLessThan(0.65);
  });
});
