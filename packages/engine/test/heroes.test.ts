import { describe, it, expect } from 'vitest';
import { HeroInjector } from '../src/heroes/HeroInjector.js';
import type { HeroConfig } from '@memberjunction/loom-contracts';

describe('HeroInjector', () => {
  const testNamespace = '9b1dcbf2-c053-41e8-a2f4-d40e11ce66a1';
  const heroMock: HeroConfig = {
    heroKey: 'elena-rodriguez',
    entity: 'Person',
    businessKeys: { Email: 'elena.rodriguez@example.com' },
    fixedFields: { FirstName: 'Elena', LastName: 'Rodriguez' },
    birthCycle: 0,
    latentDials: { engagement: 2.5, affluence: 1.8 },
    ladderEntries: [
      { ladderKey: 'governance', state: 'director', enterCycle: 2, exitCycle: 4 },
    ],
    eras: ['post-covid-boom'],
    pins: [
      { kind: 'field', field: 'FirstName', op: 'eq', value: 'Elena' },
      { kind: 'outcome', factor: 'board-service', cycle: 2, value: true },
    ],
  };

  it('mints deterministic UUIDs across instances with same business key', () => {
    const injector1 = new HeroInjector('more-cheese', testNamespace, [heroMock]);
    const injector2 = new HeroInjector('more-cheese', testNamespace, [heroMock]);

    const hero1 = injector1.GetHero('elena-rodriguez')!;
    const hero2 = injector2.GetHero('elena-rodriguez')!;

    expect(hero1).toBeDefined();
    expect(hero2).toBeDefined();
    expect(hero1.id).toBe(hero2.id);
  });

  it('correctly resolves outcome pins', () => {
    const injector = new HeroInjector('more-cheese', testNamespace, [heroMock]);
    expect(injector.GetOutcomePin('elena-rodriguez', 'board-service', 2)).toBe(true);
    expect(injector.GetOutcomePin('elena-rodriguez', 'board-service', 3)).toBeUndefined();
    expect(injector.GetOutcomePin('elena-rodriguez', 'other-factor', 2)).toBeUndefined();
  });

  it('validates field pins against realized rows', () => {
    const injector = new HeroInjector('more-cheese', testNamespace, [heroMock]);

    const matchingRow = { FirstName: 'Elena', LastName: 'Rodriguez' };
    const validRes = injector.ValidateFieldPins('elena-rodriguez', matchingRow);
    expect(validRes.valid).toBe(true);
    expect(validRes.failedPins).toHaveLength(0);

    const nonMatchingRow = { FirstName: 'Maria', LastName: 'Rodriguez' };
    const invalidRes = injector.ValidateFieldPins('elena-rodriguez', nonMatchingRow);
    expect(invalidRes.valid).toBe(false);
    expect(invalidRes.failedPins).toHaveLength(1);
  });
});
