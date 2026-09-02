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

  public registerNode(node: SimulationNode): void {
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
  public resolveOrder(): SimulationNode[] {
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
      for (const consumed of node.consumes) {
        const producerId = entityProducers.get(consumed);
        if (!producerId) {
          throw new Error(
            `CausalGraphResolver: node '${node.id}' consumes '${consumed}', but no node produces it`
          );
        }
        if (producerId !== node.id) {
          const dependents = adj.get(producerId)!;
          if (!dependents.has(node.id)) {
            dependents.add(node.id);
            inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
          }
        }
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [nodeId, deg] of inDegree.entries()) {
      if (deg === 0) {
        queue.push(nodeId);
      }
    }

    const order: SimulationNode[] = [];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const node = this.nodes.get(currentId)!;
      order.push(node);

      for (const dependentId of adj.get(currentId)!) {
        const currentDeg = inDegree.get(dependentId)! - 1;
        inDegree.set(dependentId, currentDeg);
        if (currentDeg === 0) {
          queue.push(dependentId);
        }
      }
    }

    if (order.length !== nodeArray.length) {
      const remaining = nodeArray.filter(n => (inDegree.get(n.id) ?? 0) > 0).map(n => n.id);
      throw new Error(
        `CausalGraphResolver: cyclic dependency detected among nodes: [${remaining.join(', ')}]`
      );
    }

    return order;
  }
}
