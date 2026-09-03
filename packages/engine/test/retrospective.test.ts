import { describe, it, expect } from 'vitest';
import { RetrospectiveUnroller } from '../src/simulation/RetrospectiveUnroller.js';
import { HeroInjector } from '../src/heroes/HeroInjector.js';
import { MotifSampler } from '../src/motifs/MotifSampler.js';
import { StateLadderEngine } from '../src/ladders/StateLadderEngine.js';
import { FactorEngine } from '../src/factors/engine.js';
import { RngStream } from '../src/math/rng.js';
import type {
  FactorContract,
  HeroConfig,
  MotifConfig,
  EraConfig,
  StateLadderConfig,
} from '@memberjunction/loom-contracts';

describe('RetrospectiveUnroller', () => {
  const testNamespace = '9b1dcbf2-c053-41e8-a2f4-d40e11ce66a1';

  const contractMock: FactorContract = {
    id: 'annual-renewal',
    effect: 'Binary renewal probability',
    target: 0.8,
    tolerance: 0.05,
    evidence: { source: 'industry-benchmarks', confidence: 'high' },
    outcome: { aggregation: 'exists' },
    arrows: {
      engagement: { name: 'engagement', beta: 0.5, feature: { aggregation: 'avg' } },
    },
  };

  const heroMock: HeroConfig = {
    heroKey: 'priya-natarajan',
    entity: 'Person',
    businessKeys: { Email: 'priya@example.com' },
    fixedFields: { FirstName: 'Priya' },
    birthCycle: 2021,
    latentDials: { engagement: 3.0 },
    ladderEntries: [
      { ladderKey: 'icf-gov', state: 'director', enterCycle: 2022, exitCycle: 2024 },
      { ladderKey: 'icf-gov', state: 'chair', enterCycle: 2024, exitCycle: 2026 },
    ],
    eras: [],
    pins: [
      // Hero outcome pin: conditioned to false at absolute cycle 2022
      { kind: 'outcome', factor: 'annual-renewal', cycle: 2022, value: false },
    ],
  };

  const ladderMock: StateLadderConfig = {
    ladderKey: 'icf-gov',
    entity: 'Person',
    binding: { mode: 'field', field: 'CurrentRole' },
    cohortShare: 1.0,
    states: [
      { name: 'director', durationCycles: 2, capacity: 15, effects: [], exitEffects: [] },
      { name: 'chair', durationCycles: 2, capacity: 1, effects: [], exitEffects: [] },
    ],
  };

  const motifRisingStar: MotifConfig = {
    motifKey: 'rising-star',
    targetEntity: 'Person',
    quota: { mode: 'count', value: 1, rounding: 'round' },
    latentTrajectory: { dial: 'engagement', deltaPerCycle: 0.5 },
    childRates: [],
    eras: [],
    factorOverrides: [],
  };

  const motifQuietFade: MotifConfig = {
    motifKey: 'quiet-fade',
    targetEntity: 'Person',
    quota: { mode: 'count', value: 1, rounding: 'round' },
    latentTrajectory: { dial: 'engagement', deltaPerCycle: -0.5 },
    childRates: [],
    eras: [],
    factorOverrides: [],
  };

  it('runs retrospective simulation across absolute cycles, honors hero outcome pins and exact trajectories', () => {
    const heroInjector = new HeroInjector('test-domain', testNamespace, [heroMock]);
    const motifSampler = new MotifSampler([motifRisingStar, motifQuietFade]);
    const ladderEngine = new StateLadderEngine([ladderMock]);
    const factorEngine = new FactorEngine();
    const rng = new RngStream(12345);

    const nonHero1 = {
      id: 'person-rising',
      entity: 'Person',
      birthCycle: 2021,
      latentDials: { engagement: 1.0 },
      isHero: false,
    };

    const nonHero2 = {
      id: 'person-fading',
      entity: 'Person',
      birthCycle: 2021,
      latentDials: { engagement: 2.0 },
      isHero: false,
    };

    const unroller = new RetrospectiveUnroller({
      cycles: [2021, 2022, 2023, 2024],
      entities: [nonHero1, nonHero2],
      heroInjector,
      motifSampler,
      ladderEngine,
      factorEngine,
      factorContracts: [contractMock],
    });

    unroller.Initialize(rng);
    const snapshots = unroller.Run(rng);

    expect(snapshots).toHaveLength(4);
    expect(snapshots[0]?.cycle).toBe(2021);
    expect(snapshots[0]?.activePopulation).toBe(3); // hero + 2 nonHeroes

    // Check Priya's outcome pin at cycle 2022 is strictly false
    const priyaId = heroInjector.GetHero('priya-natarajan')!.id;
    const priyaState = unroller.GetEntityState(priyaId)!;
    expect(priyaState.outcomesByCycle.get(2022)?.['annual-renewal']).toBe(false);

    // Check Priya's scripted ladder progression across absolute cycles
    expect(ladderEngine.GetEntityState('icf-gov', priyaId)?.history).toHaveLength(2);
    expect(ladderEngine.GetEntityState('icf-gov', priyaId)?.currentState).toBe('chair');

    // Check exact trajectory for rising star (+0.5/cycle for 4 cycles from 1.0 = 3.0)
    const risingState = unroller.GetEntityState('person-rising')!;
    expect(risingState.latentDials['engagement']).toBe(3.0);

    // Check exact trajectory for quiet fade (-0.5/cycle for 4 cycles from 2.0 = 0.0)
    const fadingState = unroller.GetEntityState('person-fading')!;
    expect(fadingState.latentDials['engagement']).toBe(0.0);
  });

  it('applies macroeconomic era delta intercepts at absolute cycles', () => {
    const eraCrash2025: EraConfig = {
      eraKey: 'crash-2025',
      scope: 'all',
      cycles: [2025],
      factorAdjustments: [
        { factor: 'annual-renewal', deltaIntercept: -2.0 }, // strong negative shock
      ],
      volumeMultipliers: [],
    };

    const heroInjector = new HeroInjector('test-domain', testNamespace, []);
    const motifSampler = new MotifSampler([]);
    const ladderEngine = new StateLadderEngine([]);
    const factorEngine = new FactorEngine();

    const entities = Array.from({ length: 50 }, (_, i) => ({
      id: `p-${i}`,
      entity: 'Person',
      birthCycle: 2024,
      latentDials: { engagement: 0.0 },
      isHero: false,
    }));

    const unroller = new RetrospectiveUnroller({
      cycles: [2024, 2025],
      entities,
      heroInjector,
      motifSampler,
      ladderEngine,
      factorEngine,
      eras: [eraCrash2025],
      factorContracts: [contractMock],
    });

    const rng = new RngStream(999);
    unroller.Initialize(rng);
    const snapshots = unroller.Run(rng);

    expect(snapshots[0]?.cycle).toBe(2024);
    expect(snapshots[0]?.activeEras).toHaveLength(0);

    expect(snapshots[1]?.cycle).toBe(2025);
    expect(snapshots[1]?.activeEras).toContain('crash-2025');
    // Renewal rate under -2.0 logit shock must be substantially lower than target 0.8
    const crashRenewals = snapshots[1]?.outcomesCount['annual-renewal'] ?? 0;
    const crashRate = crashRenewals / 50;
    expect(crashRate).toBeLessThan(0.60);
  });

  it('Gate 4 & calibration: recovers target rate within tolerance at N >= 5000 and recovers authored beta within +-0.15', () => {
    const N = 5000;
    const heroInjector = new HeroInjector('test-domain', testNamespace, []);
    const motifSampler = new MotifSampler([]);
    const ladderEngine = new StateLadderEngine([]);
    const factorEngine = new FactorEngine();

    // Register latent dial with zero mean and unit variance
    factorEngine.RegisterDial({
      name: 'engagement',
      mean: 0,
      stdDev: 1.0,
      correlations: {},
      annualWanderStdDev: 0.0, // static for 1-cycle test
    });

    const authoredBeta = 0.5;
    const contract: FactorContract = {
      id: 'test-renewal',
      effect: 'Binary renewal probability',
      target: 0.80,
      tolerance: 0.05,
      evidence: { source: 'test', confidence: 'high' },
      outcome: { aggregation: 'exists' },
      arrows: {
        engagement: { name: 'engagement', beta: authoredBeta, feature: { aggregation: 'avg' } },
      },
    };

    const rngInit = new RngStream(42);
    const entities = Array.from({ length: N }, (_, i) => {
      const prof = factorEngine.InitializeProfile(rngInit, `entity-${i}`);
      return {
        id: `entity-${i}`,
        entity: 'Person',
        birthCycle: 2020,
        latentDials: prof.dials,
        isHero: false,
      };
    });

    const unroller = new RetrospectiveUnroller({
      cycles: [2020],
      entities,
      heroInjector,
      motifSampler,
      ladderEngine,
      factorEngine,
      factorContracts: [contract],
    });

    const rngRun = new RngStream(42);
    unroller.Initialize(rngRun);
    const snapshots = unroller.Run(rngRun);

    const realizedCount = snapshots[0]?.outcomesCount['test-renewal'] ?? 0;
    const realizedRate = realizedCount / N;

    // 1. Target rate recovery check: |realized - 0.80| <= 0.05
    expect(Math.abs(realizedRate - 0.80)).toBeLessThanOrEqual(contract.tolerance);

    // 2. Gate 4 beta recovery check: logistic regression slope estimation
    // Log-odds approximation: covariance(outcome, dial) / variance(dial)
    let sumDial = 0;
    let sumOutcome = 0;
    let sumDialSq = 0;
    let sumCross = 0;

    for (const entity of unroller.GetAllEntityStates()) {
      const x = entity.latentDials['engagement'] ?? 0;
      const y = entity.outcomesByCycle.get(2020)?.['test-renewal'] ? 1 : 0;
      sumDial += x;
      sumOutcome += y;
      sumDialSq += x * x;
      sumCross += x * y;
    }

    const meanX = sumDial / N;
    const meanY = sumOutcome / N;
    const varX = (sumDialSq / N) - (meanX * meanX);
    const covXY = (sumCross / N) - (meanX * meanY);

    // In a logit model P(Y=1|X) = sigmoid(b0 + beta*X),
    // linear regression slope = beta * p * (1 - p).
    // Therefore recoveredBeta = (covXY / varX) / (p * (1 - p)).
    const linearSlope = covXY / varX;
    const pVar = meanY * (1 - meanY);
    const recoveredBeta = linearSlope / pVar;

    expect(Math.abs(recoveredBeta - authoredBeta)).toBeLessThanOrEqual(0.15);
  });

  it('Invariant 3: adding a hero changes no other entity records (byte-compare idempotency)', () => {
    const motifSampler = new MotifSampler([]);
    const ladderEngine1 = new StateLadderEngine([ladderMock]);
    const ladderEngine2 = new StateLadderEngine([ladderMock]);
    const factorEngine = new FactorEngine();

    const nonHeroes = Array.from({ length: 20 }, (_, i) => ({
      id: `p-${i}`,
      entity: 'Person',
      birthCycle: 2021,
      latentDials: { engagement: (i - 10) * 0.1 },
      isHero: false,
    }));

    // Run 1: without hero
    const unrollerWithoutHero = new RetrospectiveUnroller({
      cycles: [2021, 2022],
      entities: nonHeroes,
      heroInjector: new HeroInjector('test-domain', testNamespace, []),
      motifSampler,
      ladderEngine: ladderEngine1,
      factorEngine,
      factorContracts: [contractMock],
    });

    const rng1 = new RngStream(777);
    unrollerWithoutHero.Initialize(rng1);
    unrollerWithoutHero.Run(rng1);

    // Run 2: with hero added
    const heroInjectorWithHero = new HeroInjector('test-domain', testNamespace, [heroMock]);
    const unrollerWithHero = new RetrospectiveUnroller({
      cycles: [2021, 2022],
      entities: nonHeroes,
      heroInjector: heroInjectorWithHero,
      motifSampler,
      ladderEngine: ladderEngine2,
      factorEngine,
      factorContracts: [contractMock],
    });

    const rng2 = new RngStream(777);
    unrollerWithHero.Initialize(rng2);
    unrollerWithHero.Run(rng2);

    // Assert that every non-hero record in Run 2 is 100% identical to Run 1
    for (const nonHero of nonHeroes) {
      const state1 = unrollerWithoutHero.GetEntityState(nonHero.id)!;
      const state2 = unrollerWithHero.GetEntityState(nonHero.id)!;

      expect(state1.latentDials).toEqual(state2.latentDials);
      expect(state1.outcomesByCycle.get(2021)).toEqual(state2.outcomesByCycle.get(2021));
      expect(state1.outcomesByCycle.get(2022)).toEqual(state2.outcomesByCycle.get(2022));
    }
  });
});
