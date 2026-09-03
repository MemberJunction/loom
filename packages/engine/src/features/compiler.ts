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
 * Supports self-entity queries, multi-hop foreign key traversal, and child aggregations.
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

  // Case 2: Child collection aggregation (e.g. from: 'Order', aggregation: 'sum', field: 'Total')
  if (query.aggregation) {
    const childEntity = query.from;
    const agg = query.aggregation;
    const aggField = query.field;
    const criteria = query.where ? Object.entries(query.where) : null;

    return (e, ctx) => {
      if (!ctx) {
        throw new Error(`compileFeature: aggregation query for '${childEntity}' requires a RelationalContext`);
      }
      const parentId = String(e['ID'] ?? e['id']);
      // Look up children linked to this parent
      let children = ctx.getChildren('', parentId, childEntity, '');

      if (criteria) {
        children = children.filter((child) => criteria.every(([k, v]) => child[k] === v));
      }

      if (agg === 'count') return children.length;
      if (agg === 'exists') return children.length > 0 ? 1 : 0;

      if (children.length === 0) return 0;

      const nums = children
        .map((c) => (aggField ? Number(c[aggField]) : 0))
        .filter((n) => !isNaN(n));

      if (nums.length === 0) return 0;

      switch (agg) {
        case 'sum':
          return nums.reduce((a, b) => a + b, 0);
        case 'avg':
          return nums.reduce((a, b) => a + b, 0) / nums.length;
        case 'min':
          return Math.min(...nums);
        case 'max':
          return Math.max(...nums);
      }
    };
  }

  // Case 3: Multi-hop relational query across foreign keys
  // Path elements can be 'fkField:TargetEntity' or simply field names
  const targetEntity = query.from;

  return (e, ctx) => {
    if (!ctx) {
      throw new Error(`compileFeature: relational query for '${targetEntity}' requires a RelationalContext`);
    }

    if (query.path && query.path.length > 0) {
      let currentVal: unknown = e;
      for (let i = 0; i < query.path.length; i++) {
        const rawSegment = query.path[i]!;
        if (!currentVal || typeof currentVal !== 'object') return 0;

        const [fieldName, nextEntityType] = rawSegment.split(':');
        const nextVal: unknown = (currentVal as Record<string, unknown>)[fieldName!];

        if (i < query.path.length - 1) {
          // Hop across foreign key to next entity
          const entityType = nextEntityType ?? targetEntity;
          if (typeof nextVal === 'string') {
            currentVal = ctx.getEntity(entityType, nextVal);
          } else {
            return 0;
          }
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

export type RawFeatureEvaluator = (
  entity: EntityRecord,
  context?: RelationalContext
) => unknown;

/**
 * Compiles a FeatureQuery into a raw-value evaluator preserving strings, dates, and booleans.
 * Used for Gate 0 feature pin evaluation without numeric coercion.
 */
export function compileRawFeature(query: FeatureQuery): RawFeatureEvaluator {
  if (query.from === 'self') {
    if (query.field) {
      const fieldName = query.field;
      return (e) => e[fieldName];
    }
    if (query.where) {
      const criteria = Object.entries(query.where);
      return (e) => criteria.every(([k, v]) => e[k] === v);
    }
    throw new Error(`compileRawFeature: self query requires either 'field' or 'where'`);
  }

  if (query.aggregation) {
    const childEntity = query.from;
    const agg = query.aggregation;
    const aggField = query.field;
    const criteria = query.where ? Object.entries(query.where) : null;

    return (e, ctx) => {
      if (!ctx) {
        throw new Error(`compileRawFeature: aggregation query for '${childEntity}' requires a RelationalContext`);
      }
      const parentId = String(e['ID'] ?? e['id']);
      let children = ctx.getChildren('', parentId, childEntity, '');

      if (criteria) {
        children = children.filter((child) => criteria.every(([k, v]) => child[k] === v));
      }

      if (agg === 'count') return children.length;
      if (agg === 'exists') return children.length > 0 ? 1 : 0;

      if (children.length === 0) return undefined;

      const rawValues = children.map((c) => (aggField ? c[aggField] : undefined)).filter((v) => v !== undefined);
      if (rawValues.length === 0) return undefined;

      // Handle dates
      const isDate = rawValues.every((v) => typeof v === 'string' && !isNaN(Date.parse(v)));
      if (isDate) {
        const timestamps = rawValues.map((v) => new Date(v as string).getTime());
        if (agg === 'min') return new Date(Math.min(...timestamps)).toISOString();
        if (agg === 'max') return new Date(Math.max(...timestamps)).toISOString();
      }

      const nums = rawValues.map((v) => Number(v)).filter((n) => !isNaN(n));
      if (nums.length === 0) return undefined;

      switch (agg) {
        case 'sum':
          return nums.reduce((a, b) => a + b, 0);
        case 'avg':
          return nums.reduce((a, b) => a + b, 0) / nums.length;
        case 'min':
          return Math.min(...nums);
        case 'max':
          return Math.max(...nums);
        default:
          return undefined;
      }
    };
  }

  const targetEntity = query.from;
  return (e, ctx) => {
    if (!ctx) {
      throw new Error(`compileRawFeature: relational query for '${targetEntity}' requires a RelationalContext`);
    }

    if (query.path && query.path.length > 0) {
      let currentVal: unknown = e;
      for (let i = 0; i < query.path.length; i++) {
        const rawSegment = query.path[i]!;
        if (!currentVal || typeof currentVal !== 'object') return undefined;

        const [fieldName, nextEntityType] = rawSegment.split(':');
        const nextVal: unknown = (currentVal as Record<string, unknown>)[fieldName!];

        if (i < query.path.length - 1) {
          const entityType = nextEntityType ?? targetEntity;
          if (typeof nextVal === 'string') {
            currentVal = ctx.getEntity(entityType, nextVal);
          } else {
            return undefined;
          }
        } else {
          currentVal = nextVal;
        }
      }
      return currentVal;
    }

    return undefined;
  };
}

