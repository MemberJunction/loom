import type { DomainConfig } from '@memberjunction/loom-contracts';

export interface ExecutionContext {
  domain: DomainConfig;
  seed: number;
  asOfDate: string;
  priorState?: Record<string, readonly Record<string, unknown>[]>;
  generatedData: Map<string, Record<string, unknown>[]>;
}

export interface SimulationNode {
  id: string;
  consumes: readonly string[];
  produces: readonly string[];
  description?: string;
  execute: (context: ExecutionContext) => Promise<Record<string, Record<string, unknown>[]>>;
}

/**
 * Resolves simulation nodes into a valid topological DAG execution sequence.
 */
export class CausalGraphResolver {
  private nodes = new Map<string, SimulationNode>();

  public RegisterNode(node: SimulationNode): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`CausalGraphResolver: node '${node.id}' is already registered`);
    }
    this.nodes.set(node.id, node);
  }

  /**
   * Sorts registered nodes in topological execution order.
   * Ensures that for every node, all produced entities it consumes
   * are provided by an earlier node in the sequence.
   */
  public ResolveOrder(): SimulationNode[] {
    const nodeArray = Array.from(this.nodes.values());
    const entityProducers = new Map<string, string>(); // entityName -> nodeId

    // Index which node produces which entity
    for (const node of nodeArray) {
      for (const prod of node.produces) {
        if (entityProducers.has(prod)) {
          throw new Error(
            `CausalGraphResolver: conflict on produced entity '${prod}' — both '${entityProducers.get(prod)}' and '${node.id}' claim to produce it`
          );
        }
        entityProducers.set(prod, node.id);
      }
    }

    // Build adjacency list: nodeA -> set of nodes that depend on nodeA
    const inDegree = new Map<string, number>();
    const adj = new Map<string, Set<string>>();

    for (const node of nodeArray) {
      inDegree.set(node.id, 0);
      adj.set(node.id, new Set());
    }

    for (const node of nodeArray) {
      for (const consumedEntity of node.consumes) {
        const producerNodeId = entityProducers.get(consumedEntity);
        if (!producerNodeId) {
          throw new Error(
            `CausalGraphResolver: node '${node.id}' consumes entity '${consumedEntity}', but no registered node produces it`
          );
        }
        if (producerNodeId === node.id) {
          throw new Error(
            `CausalGraphResolver: node '${node.id}' cannot consume an entity it produces (self-dependency on '${consumedEntity}')`
          );
        }

        const dependents = adj.get(producerNodeId)!;
        if (!dependents.has(node.id)) {
          dependents.add(node.id);
          inDegree.set(node.id, inDegree.get(node.id)! + 1);
        }
      }
    }

    // Kahn's algorithm for topological sorting
    const queue: string[] = [];
    for (const [nodeId, deg] of inDegree.entries()) {
      if (deg === 0) {
        queue.push(nodeId);
      }
    }

    const order: SimulationNode[] = [];
    const nodeMap = new Map(nodeArray.map((n) => [n.id, n]));

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      order.push(nodeMap.get(currentId)!);

      const neighbors = adj.get(currentId) ?? new Set();
      for (const neighborId of neighbors) {
        const newDeg = inDegree.get(neighborId)! - 1;
        inDegree.set(neighborId, newDeg);
        if (newDeg === 0) {
          queue.push(neighborId);
        }
      }
    }

    if (order.length !== nodeArray.length) {
      const remainingNodes = nodeArray
        .filter((n) => !order.includes(n))
        .map((n) => n.id)
        .join(', ');
      throw new Error(
        `CausalGraphResolver: cycle detected in simulation dependency graph. Unresolvable nodes: [${remainingNodes}]`
      );
    }

    return order;
  }
}
