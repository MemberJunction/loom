import type { EntityConfig } from '@memberjunction/loom-contracts';

/**
 * Returns the primary key field names declared for an entity, in declaration order.
 * Entities that declare no primary key fall back to the conventional 'ID'.
 */
export function GetPrimaryKeyFields(entityCfg: EntityConfig | undefined): string[] {
  if (!entityCfg) return ['ID'];
  const declared = Object.entries(entityCfg.fields)
    .filter(([, f]) => f.isPrimaryKey)
    .map(([name]) => name);
  return declared.length > 0 ? declared : ['ID'];
}

/**
 * Returns the record's primary key as a single comparable string (composite keys joined with '|'),
 * or undefined when any key part is missing. Falls back to 'ID'/'id' for entities keyed by ID.
 */
export function ExtractPrimaryKey(
  record: Record<string, unknown>,
  entityCfg: EntityConfig | undefined
): string | undefined {
  const parts: string[] = [];
  for (const field of GetPrimaryKeyFields(entityCfg)) {
    const val = field === 'ID' ? record['ID'] ?? record['id'] : record[field];
    if (val === undefined || val === null || val === '') return undefined;
    parts.push(String(val));
  }
  return parts.join('|');
}
