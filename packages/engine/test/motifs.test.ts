import { describe, it, expect } from 'vitest';
import { MotifSampler, EntityCandidate } from '../src/motifs/MotifSampler.js';
import { RngStream } from '../src/math/rng.js';
import type { MotifConfig } from '@memberjunction/loom-contracts';

describe('MotifSampler', () => {
  const motifCountMock: MotifConfig = {
    motifKey: 'champion-advocate',
    targetEntity: 'Person',
    quota: { mode: 'count', value: 3, rounding: 'round' },
    latentConstraints: { engagement: { min: 1.0 } },
    childRates: [{ entity: 'AdvocacyAction', perCycle: { min: 2, max: 4 } }],
    eras: [],
    factorOverrides: [],
  };

  const motifPctMock: MotifConfig = {
    motifKey: 'corporate-ghost',
    targetEntity: 'Person',
    quota: { mode: 'percentage', value: 0.50, rounding: 'round' },
    childRates: [],
    eras: [],
    factorOverrides: [],
  };

  it('calculates quota targets correctly', () => {
    const sampler = new MotifSampler([motifCountMock, motifPctMock]);
    expect(sampler.CalculateTargetCount(motifCountMock.quota, 100)).toBe(3);
    expect(sampler.CalculateTargetCount(motifPctMock.quota, 10)).toBe(5);
  });

  it('samples population respecting latent constraints and exact count quotas', () => {
    const sampler = new MotifSampler([motifCountMock]);
    const rng = new RngStream(42);

    const candidates: EntityCandidate[] = [
      { id: '1', entity: 'Person', birthCycle: 0, latentDials: { engagement: 1.5 }, isHero: false },
      { id: '2', entity: 'Person', birthCycle: 0, latentDials: { engagement: 2.0 }, isHero: false },
      { id: '3', entity: 'Person', birthCycle: 0, latentDials: { engagement: 0.2 }, isHero: false }, // doesn't match min 1.0
      { id: '4', entity: 'Person', birthCycle: 0, latentDials: { engagement: 1.8 }, isHero: false },
      { id: '5', entity: 'Person', birthCycle: 0, latentDials: { engagement: 1.2 }, isHero: false },
    ];

    const assignments = sampler.SamplePopulation(candidates, rng);
    let totalAssigned = 0;
    for (const list of assignments.values()) {
      totalAssigned += list.filter((a) => a.motifKey === 'champion-advocate').length;
    }

    expect(totalAssigned).toBe(3);
    expect(assignments.get('3')).toBeUndefined(); // entity 3 does not satisfy latent constraint
  });
});
