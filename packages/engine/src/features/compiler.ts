import type { FeatureQuery } from '@memberjunction/loom-contracts';

export type EntityRecord = Record<string, unknown>;

export interface RelationalContext {
  getEntity(entityName: string, id: string): EntityRecord | undefined;
  getChildren(parentEntity: string, parentId: string, childEntity: string, foreignKeyField: string): readonly EntityRecord[];
}

export type FeatureEvaluator = (
  entity: EntityRecord,
  context?: RelationalContext
) => number;

/**
 * Compiles a declarative FeatureQuery into a high-performance evaluator function.
 */
export function compileFeature(query: FeatureQuery): FeatureEvaluator {
  // Case 1: Simple self-entity evaluation
  if (query.from === 'self') {
    if (query.field) {
      const fieldName = query.field;
      return (e) => {
        const val = e[fieldName];
        if (typeof val === 'boolean') return val ? 1 : 0;
        if (typeof val === 'number') return val;
        if (typeof val === 'string') {
          const num = Number(val);
          return isNaN(num) ? (val.length > 0 ? 1 : 0) : num;
        }
        return val ? 1 : 0;
      };
    }

    if (query.where) {
      const criteria = Object.entries(query.where);
      return (e) => {
        const matches = criteria.every(([k, v]) => e[k] === v);
        return matches ? 1 : 0;
      };
    }

    throw new Error(`compileFeature: self query requires either 'field' or 'where'`);
  }

  // Case 2: Multi-hop relational query across entities
  const targetEntity = query.from;

  return (e, ctx) => {
    if (!ctx) {
      throw new Error(`compileFeature: multi-hop query for '${targetEntity}' requires a RelationalContext`);
    }

    // Path traversal: e.g. path = ['CompanyID', 'EmployeeCount']
    if (query.path && query.path.length > 0) {
      let currentVal: unknown = e;
      for (let i = 0; i < query.path.length; i++) {
        const segment = query.path[i]!;
        if (!currentVal || typeof currentVal !== 'object') return 0;
        const nextVal: unknown = (currentVal as Record<string, unknown>)[segment];

        // If this is a foreign key lookup step (not the final field)
        if (i < query.path.length - 1 && typeof nextVal === 'string') {
          const related = ctx.getEntity(targetEntity, nextVal);
          currentVal = related;
        } else {
          currentVal = nextVal;
        }
      }

      if (typeof currentVal === 'number') return currentVal;
      if (typeof currentVal === 'boolean') return currentVal ? 1 : 0;
      return currentVal ? 1 : 0;
    }

    return 0;
  };
}
