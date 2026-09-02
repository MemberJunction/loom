import type { DomainConfig, DeltaRecords } from '@memberjunction/loom-contracts';

export interface AccumulationDiffResult {
  delta: DeltaRecords;
  newRecordCounts: Record<string, number>;
  modifiedRecordCounts: Record<string, number>;
  deletedRecordCounts: Record<string, number>;
}

/**
 * Computes stateful deltas between a committed prior state and the current simulation state.
 * Enforces:
 * 1. Every row must have a valid non-empty primary key (ID).
 * 2. Existing prior IDs are never reassigned to another entity or mutated.
 * 3. Immutable entity rows cannot modify previously committed fields.
 * 4. Tracks status transitions and deletions explicitly.
 */
export class Accumulator {
  public ComputeDelta(
    domain: DomainConfig,
    cycleIndex: number,
    asOfDate: string,
    priorState: Record<string, readonly Record<string, unknown>[]>,
    currentState: Record<string, readonly Record<string, unknown>[]>
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
        const id = this.extractId(r, entityName);
        globalPriorIds.set(id, entityName);
      }
    }

    for (const [entityName, currentList] of Object.entries(currentState)) {
      const entityCfg = domain.entities[entityName];
      const priorList = priorState[entityName] ?? [];

      // Index prior records by primary key (ID)
      const priorMap = new Map<string, Record<string, unknown>>();
      for (const r of priorList) {
        const id = this.extractId(r, entityName);
        priorMap.set(id, r);
      }

      const entityNewList: Record<string, unknown>[] = [];
      const currentIdsSeen = new Set<string>();
      let newCount = 0;
      let modCount = 0;

      for (const curr of currentList) {
        const id = this.extractId(curr, entityName);
        currentIdsSeen.add(id);

        // Check global prior ID collision across different entities
        const existingEntity = globalPriorIds.get(id);
        if (existingEntity && existingEntity !== entityName) {
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
          // If entity is immutable, verify that fields did not mutate.
          if (entityCfg?.isImmutable) {
            for (const [field, val] of Object.entries(curr)) {
              if (existing[field] !== undefined && existing[field] !== val) {
                throw new Error(
                  `Accumulator: immutable record mutation in entity '${entityName}' (ID: ${id}) on field '${field}'`
                );
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

  public computeDelta(
    domain: DomainConfig,
    cycleIndex: number,
    asOfDate: string,
    priorState: Record<string, readonly Record<string, unknown>[]>,
    currentState: Record<string, readonly Record<string, unknown>[]>
  ): AccumulationDiffResult {
    return this.ComputeDelta(domain, cycleIndex, asOfDate, priorState, currentState);
  }

  private extractId(record: Record<string, unknown>, entityName: string): string {
    const idVal = record['ID'] ?? record['id'];
    if (idVal === undefined || idVal === null || idVal === '') {
      throw new Error(
        `Accumulator: record in entity '${entityName}' is missing required primary key 'ID'`
      );
    }
    return String(idVal);
  }
}
