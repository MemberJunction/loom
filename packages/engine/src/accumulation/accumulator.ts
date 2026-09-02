import type { DomainConfig, DeltaRecords } from '@memberjunction/loom-contracts';

export interface AccumulationDiffResult {
  delta: DeltaRecords;
  newRecordCounts: Record<string, number>;
  modifiedRecordCounts: Record<string, number>;
}

/**
 * Computes stateful deltas between a committed prior state and the current simulation state.
 */
export class Accumulator {
  /**
   * Calculates delta records (new additions + status transitions).
   */
  public computeDelta(
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

    for (const [entityName, currentList] of Object.entries(currentState)) {
      const entityCfg = domain.entities[entityName];
      const priorList = priorState[entityName] ?? [];

      // Index prior records by primary key (ID)
      const priorMap = new Map<string, Record<string, unknown>>();
      for (const r of priorList) {
        const id = String(r['ID'] ?? r['id']);
        if (id) priorMap.set(id, r);
      }

      const entityNewList: Record<string, unknown>[] = [];
      let newCount = 0;
      let modCount = 0;

      for (const curr of currentList) {
        const id = String(curr['ID'] ?? curr['id']);
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

      newRecords[entityName] = entityNewList;
      newRecordCounts[entityName] = newCount;
      modifiedRecordCounts[entityName] = modCount;
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
    };
  }
}
