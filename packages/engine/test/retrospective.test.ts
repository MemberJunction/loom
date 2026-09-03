import { describe, it, expect } from 'vitest';
import { RetrospectiveUnroller } from '../src/simulation/RetrospectiveUnroller.js';
import { HeroInjector } from '../src/heroes/HeroInjector.js';
import { MotifSampler } from '../src/motifs/MotifSampler.js';
import { StateLadderEngine } from '../src/ladders/StateLadderEngine.js';
import { RngStream } from '../src/math/rng.js';
import type { FactorContract, HeroConfig, MotifConfig } from '@memberjunction/loom-contracts';

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
    birthCycle: 0,
    latentDials: { engagement: 3.0 },
    ladderEntries: [],
    eras: [],
    pins: [
      // Hero outcome pin: forced to false at cycle 1
      { kind: 'outcome', factor: 'annual-renewal', cycle: 1, value: false },
    ],
  };

  const motifMock: MotifConfig = {
    motifKey: 'rising-star',
    targetEntity: 'Person',
    quota: { mode: 'count', value: 1, rounding: 'round' },
    latentTrajectory: { dial: 'engagement', deltaPerCycle: 0.5 },
    childRates: [],
    eras: [],
    factorOverrides: [],
  };

  it('runs retrospective simulation and enforces hero outcome pins', () => {
    const heroInjector = new HeroInjector('test-domain', testNamespace, [heroMock]);
    const motifSampler = new MotifSampler([motifMock]);
    const ladderEngine = new StateLadderEngine([]);
    const rng = new RngStream(12345);

    const nonHero = {
      id: 'person-99',
      entity: 'Person',
      birthCycle: 0,
      latentDials: { engagement: 1.0 },
      isHero: false,
    };

    const unroller = new RetrospectiveUnroller({
      totalCycles: 3,
      entities: [nonHero],
      heroInjector,
      motifSampler,
      ladderEngine,
      factorContracts: [contractMock],
    });

    unroller.Initialize(rng);
    const snapshots = unroller.Run(rng);

    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]?.activePopulation).toBe(2); // hero + nonHero

    // Check that Priya's outcome pin at cycle 1 is strictly false
    const priyaId = heroInjector.GetHero('priya-natarajan')!.id;
    const priyaState = unroller.GetEntityState(priyaId)!;
    expect(priyaState.outcomesByCycle.get(1)?.['annual-renewal']).toBe(false);

    // Check that rising star entity's engagement dial climbed across cycles
    const nonHeroState = unroller.GetEntityState('person-99')!;
    expect(nonHeroState.motifs).toContain('rising-star');
    // Started at 1.0, climbed by 0.5 each cycle
    expect(nonHeroState.latentDials['engagement']).toBeGreaterThan(2.0);
  });
});
