/**
 * Governance Fixture Entrypoint
 * Composes nestedEvent, temporalRole, and scopedDecision patterns
 * for multi-level nested causality and tenure-scoped voting.
 */
export {
  nestedEvent,
  temporalRole,
  scopedDecision,
  type NestedEventOptions,
  type TemporalRoleOptions,
  type ScopedDecisionOptions,
  type ScopedDecisionResult,
} from '@memberjunction/loom-engine';
