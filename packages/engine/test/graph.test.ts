import { describe, it, expect } from 'vitest';
import { CausalGraphResolver, type SimulationNode } from '../src/graph/resolver.js';

describe('CausalGraphResolver', () => {
  it('topologically sorts simulation nodes according to consumed/produced entities', () => {
    const resolver = new CausalGraphResolver();

    const nodeMoney: SimulationNode = {
      id: 'node-money',
      consumes: ['OrderHeader', 'Invoice'],
      produces: ['Payment', 'JournalEntry'],
      execute: async () => ({}),
    };

    const nodeOrders: SimulationNode = {
      id: 'node-orders',
      consumes: ['Person', 'Product'],
      produces: ['OrderHeader', 'Invoice'],
      execute: async () => ({}),
    };

    const nodeWorld: SimulationNode = {
      id: 'node-world',
      consumes: [],
      produces: ['Person', 'Product'],
      execute: async () => ({}),
    };

    resolver.registerNode(nodeMoney);
    resolver.registerNode(nodeOrders);
    resolver.registerNode(nodeWorld);

    const sorted = resolver.resolveOrder();
    expect(sorted.map((n) => n.id)).toEqual(['node-world', 'node-orders', 'node-money']);
  });

  it('detects cycles and throws a clear descriptive error', () => {
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

    resolver.registerNode(nodeA);
    resolver.registerNode(nodeB);

    expect(() => resolver.resolveOrder()).toThrowError(/cyclic dependency detected/);
  });
});
