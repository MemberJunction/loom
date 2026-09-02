import { describe, it, expect } from 'vitest';
import { CausalGraphResolver, type SimulationNode } from '../src/graph/resolver.js';

describe('CausalGraphResolver', () => {
  it('correctly resolves a linear DAG order', () => {
    const resolver = new CausalGraphResolver();

    const nodeA: SimulationNode = {
      id: 'node-members',
      consumes: [],
      produces: ['Member'],
      execute: async () => ({}),
    };

    const nodeB: SimulationNode = {
      id: 'node-orders',
      consumes: ['Member'],
      produces: ['Order'],
      execute: async () => ({}),
    };

    resolver.RegisterNode(nodeB);
    resolver.RegisterNode(nodeA);

    const order = resolver.ResolveOrder();
    expect(order.map((n) => n.id)).toEqual(['node-members', 'node-orders']);
  });

  it('detects and rejects dependency cycles', () => {
    const resolver = new CausalGraphResolver();

    const nodeA: SimulationNode = {
      id: 'node-a',
      consumes: ['EntityB'],
      produces: ['EntityA'],
      execute: async () => ({}),
    };

    const nodeB: SimulationNode = {
      id: 'node-b',
      consumes: ['EntityA'],
      produces: ['EntityB'],
      execute: async () => ({}),
    };

    resolver.RegisterNode(nodeA);
    resolver.RegisterNode(nodeB);

    expect(() => resolver.ResolveOrder()).toThrowError(/cycle detected/);
  });
});
