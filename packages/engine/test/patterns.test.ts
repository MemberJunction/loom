import { describe, it, expect } from 'vitest';
import {
  annualParticipation,
  recurringDecision,
  childOutcome,
  derivedTransaction,
  staticAssignment,
} from '../src/patterns/index.js';

describe('Decision Patterns', () => {
  it('annualParticipation spawns child records at calibrated rate', () => {
    interface Member { id: string; score: number }
    const pool: Member[] = [];
    for (let i = 1; i <= 200; i++) {
      pool.push({ id: `m-${i}`, score: (i % 5) - 2 });
    }

    const spawned = annualParticipation<Member, { memberId: string; year: number }>({
      seed: 42,
      years: [2024, 2025],
      poolOf: () => pool,
      scoreOf: (m) => m.score * 0.5,
      target: 0.35, // 35% conference attendance rate
      streamKey: (m, y) => `attend:${m.id}:${y}`,
      spawn: (_r, m, y) => ({ memberId: m.id, year: y }),
    });

    const expectedTotal = 200 * 2 * 0.35; // ~140
    expect(spawned.length).toBeGreaterThan(expectedTotal - 25);
    expect(spawned.length).toBeLessThan(expectedTotal + 25);
  });

  it('recurringDecision respects pinned decisions and triggers onDecision callbacks', () => {
    interface Account { id: string; tenureYears: number }
    const accounts: Account[] = [
      { id: 'acc-1', tenureYears: 1 },
      { id: 'acc-2', tenureYears: 5 },
      { id: 'acc-pinned-yes', tenureYears: 0 },
      { id: 'acc-pinned-no', tenureYears: 10 },
    ];

    const results = new Map<string, boolean>();

    recurringDecision<Account, void>({
      seed: 777,
      cycles: [2026],
      cohortOf: () => accounts,
      scoreOf: (acc) => acc.tenureYears * 0.2,
      target: 0.85,
      streamKey: (acc, c) => `renew:${acc.id}:${c}`,
      pinnedDecision: (acc) => {
        if (acc.id === 'acc-pinned-yes') return true;
        if (acc.id === 'acc-pinned-no') return false;
        return null; // roll dice
      },
      onDecision: (acc, _c, yes) => {
        results.set(acc.id, yes);
      },
    });

    expect(results.get('acc-pinned-yes')).toBe(true);
    expect(results.get('acc-pinned-no')).toBe(false);
    expect(results.size).toBe(4);
  });

  it('childOutcome assigns calibrated binary outcomes', () => {
    const parents = Array.from({ length: 100 }, (_, i) => ({ id: `p-${i}`, affluence: (i - 50) / 25 }));

    const outcomes = childOutcome({
      seed: 123,
      parents,
      scoreOf: (p) => p.affluence,
      target: 0.20,
      streamKey: (p) => `pass:${p.id}`,
      onPositive: (p) => ({ parentId: p.id, tier: 'VIP' }),
      onNegative: (p) => ({ parentId: p.id, tier: 'Standard' }),
    });

    const vipCount = outcomes.filter((o) => o.tier === 'VIP').length;
    expect(vipCount).toBeGreaterThan(12);
    expect(vipCount).toBeLessThan(28);
  });

  it('derivedTransaction creates transactions with valid offset days', () => {
    const orders = [{ id: 'ord-101' }, { id: 'ord-102' }];

    const payments = derivedTransaction({
      seed: 42,
      parents: orders,
      streamKey: (o) => `pay:${o.id}`,
      timing: { type: 'uniformDays', min: 1, max: 14 },
      createTransaction: (_r, o, days) => ({ orderId: o.id, offsetDays: days }),
    });

    expect(payments).toHaveLength(2);
    expect(payments[0]!.offsetDays).toBeGreaterThanOrEqual(1);
    expect(payments[0]!.offsetDays).toBeLessThanOrEqual(14);
  });

  it('staticAssignment matches ordered criteria and falls back to default rule', () => {
    const rules = [
      { when: { Segment: 'Enterprise' }, value: 'Tier-1' },
      { whenAbove: { Affluence: 1.5 }, value: 'Tier-2' },
      { value: 'Tier-Standard' }, // Default
    ];

    expect(staticAssignment(rules, { Segment: 'Enterprise', Affluence: 0.5 })).toBe('Tier-1');
    expect(staticAssignment(rules, { Segment: 'SMB', Affluence: 2.1 })).toBe('Tier-2');
    expect(staticAssignment(rules, { Segment: 'SMB', Affluence: 0.8 })).toBe('Tier-Standard');
  });
});
