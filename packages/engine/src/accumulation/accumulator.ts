import type { DomainConfig, DeltaRecords, EntityConfig } from '@memberjunction/loom-contracts';
import { ExtractPrimaryKey, GetPrimaryKeyFields } from '../identity/primaryKey.js';

export interface AccumulationDiffResult {
  delta: DeltaRecords;
  newRecordCounts: Record<string, number>;
  modifiedRecordCounts: Record<string, number>;
  deletedRecordCounts: Record<string, number>;
}

export interface AccumulatorOptions {
  allowDeletions?: boolean;
}

/**
 * Computes stateful deltas between a committed prior state and the current simulation state.
 * Enforces:
 * 1. Every row must have a valid non-empty primary key (its declared primary key fields, else ID).
 * 2. Existing prior IDs are never reassigned to another entity or deleted (unless allowDeletions is set).
 *    An IsA child and its parent share one ID by design, so that pair is not a reassignment.
 * 3. Immutable entity rows cannot modify previously committed fields (with deep object comparison).
 * 4. Tracks status transitions and new records explicitly.
 */
export class Accumulator {
  public ComputeDelta(
    domain: DomainConfig,
    cycleIndex: number,
    asOfDate: string,
    priorState: Record<string, readonly Record<string, unknown>[]>,
    currentState: Record<string, readonly Record<string, unknown>[]>,
    options: AccumulatorOptions = {}
  ): AccumulationDiffResult {
    const newRecords: Record<string, Record<string, unknown>[]> = {};
    const statusTransitions: DeltaRecords['statusTransitions'] = [];
    const newRecordCounts: Record<string, number> = {};
    const modifiedRecordCounts: Record<string, number> = {};
    const deletedRecordCounts: Record<string, number> = {};

    // Global map of prior IDs to their entity type to prevent ID cross-reassignment
    const globalPriorIds = new Map<string, string>();
    for (const [entityName, list] of Object.entries(priorState)) {
      for (const r of list) {
        const id = this.extractId(r, entityName, domain.entities[entityName]);
        globalPriorIds.set(id, entityName);
      }
    }

    for (const [entityName, currentList] of Object.entries(currentState)) {
      const entityCfg = domain.entities[entityName];
      const priorList = priorState[entityName] ?? [];

      // Index prior records by primary key (ID)
      const priorMap = new Map<string, Record<string, unknown>>();
      for (const r of priorList) {
        const id = this.extractId(r, entityName, entityCfg);
        priorMap.set(id, r);
      }

      const entityNewList: Record<string, unknown>[] = [];
      const currentIdsSeen = new Set<string>();
      let newCount = 0;
      let modCount = 0;

      for (const curr of currentList) {
        const id = this.extractId(curr, entityName, entityCfg);
        currentIdsSeen.add(id);

        // Check global prior ID collision across different entities
        const existingEntity = globalPriorIds.get(id);
        if (existingEntity && existingEntity !== entityName && !this.isIsAPair(domain, existingEntity, entityName)) {
          throw new Error(
            `Accumulator: invariant violation — ID '${id}' was previously committed for entity '${existingEntity}' and cannot be reassigned to '${entityName}'`
          );
        }

        const existing = priorMap.get(id);

        if (!existing) {
          // Brand new record
          entityNewList.push(curr);
          newCount++;
        } else {
          // Record was previously committed.
          // If entity is immutable, verify that fields did not mutate (deep comparison).
          if (entityCfg?.isImmutable) {
            for (const [field, val] of Object.entries(curr)) {
              if (existing[field] !== undefined) {
                const isDifferent =
                  typeof existing[field] === 'object' || typeof val === 'object'
                    ? JSON.stringify(existing[field]) !== JSON.stringify(val)
                    : existing[field] !== val;

                if (isDifferent) {
                  throw new Error(
                    `Accumulator: immutable record mutation in entity '${entityName}' (ID: ${id}) on field '${field}'`
                  );
                }
              }
            }
          }

          // Check for status transitions if Status field exists
          if (curr['Status'] !== undefined && existing['Status'] !== curr['Status']) {
            statusTransitions.push({
              entity: entityName,
              id,
              fromStatus: String(existing['Status']),
              toStatus: String(curr['Status']),
              effectiveDate: asOfDate,
            });
            modCount++;
          }
        }
      }

      // Check for deletions from prior state
      let deletedCount = 0;
      for (const priorId of priorMap.keys()) {
        if (!currentIdsSeen.has(priorId)) {
          deletedCount++;
        }
      }

      if (deletedCount > 0 && !options.allowDeletions) {
        throw new Error(
          `Accumulator: invariant violation — ${deletedCount} record(s) deleted from prior state in entity '${entityName}'. Existing records cannot be deleted from accumulated simulation state.`
        );
      }

      newRecords[entityName] = entityNewList;
      newRecordCounts[entityName] = newCount;
      modifiedRecordCounts[entityName] = modCount;
      deletedRecordCounts[entityName] = deletedCount;
    }

    const delta: DeltaRecords = {
      cycleIndex,
      asOfDate,
      generatedRecords: newRecords,
      statusTransitions,
    };

    return {
      delta,
      newRecordCounts,
      modifiedRecordCounts,
      deletedRecordCounts,
    };
  }

  private extractId(record: Record<string, unknown>, entityName: string, entityCfg: EntityConfig | undefined): string {
    const id = ExtractPrimaryKey(record, entityCfg);
    if (id === undefined) {
      throw new Error(
        `Accumulator: record in entity '${entityName}' is missing required primary key '${GetPrimaryKeyFields(entityCfg).join(', ')}'`
      );
    }
    return id;
  }

  /** True when one entity is the IsA child of the other (the two rows share one primary key). */
  private isIsAPair(domain: DomainConfig, a: string, b: string): boolean {
    return (
      domain.entities[a]?.composition?.isA?.parentEntity === b ||
      domain.entities[b]?.composition?.isA?.parentEntity === a
    );
  }
}
