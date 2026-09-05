import type { DomainConfig, EntityConfig } from '@memberjunction/loom-contracts';
import { AvatarGenerator } from './AvatarGenerator.js';
import { LogoGenerator } from './LogoGenerator.js';

function fieldValue(row: Record<string, unknown>, fieldName: string): unknown {
  if (fieldName === 'ID' || fieldName === 'id') {
    return row.ID ?? row.id;
  }
  return row[fieldName];
}

export function applyFieldGeneratorsToRow(
  entityCfg: EntityConfig,
  row: Record<string, unknown>,
  entityName: string,
): Record<string, unknown> {
  const next = { ...row };
  for (const [fieldName, fieldCfg] of Object.entries(entityCfg.fields)) {
    if (fieldCfg.avatar) {
      const cfg = fieldCfg.avatar;
      const seedVal = fieldValue(next, cfg.seedField || 'ID') ?? `${entityName}`;
      const traitRaw = cfg.traitField ? fieldValue(next, cfg.traitField) : undefined;
      next[fieldName] = AvatarGenerator.Generate({
        seed: String(seedVal),
        trait: traitRaw !== undefined && traitRaw !== null ? String(traitRaw) : undefined,
        traits: cfg.traits as Record<string, Record<string, unknown>> | undefined,
        defaultTrait: cfg.defaultTrait,
        style: cfg.style,
        format: cfg.format,
        backgroundColor: cfg.backgroundColor,
        maxLength: cfg.maxLength ?? fieldCfg.maxLength,
      });
    } else if (fieldCfg.logo) {
      const cfg = fieldCfg.logo;
      const nameVal = fieldValue(next, cfg.nameField || 'Name') ?? entityName;
      const seedVal = fieldValue(next, cfg.seedField || 'ID') ?? nameVal;
      next[fieldName] = LogoGenerator.Generate({
        name: String(nameVal),
        seed: String(seedVal),
        format: cfg.format,
        shape: cfg.shape,
      });
    }
  }
  return next;
}

/**
 * Apply declared avatar/logo generators to already-built records (loom decorate).
 */
export function applyFieldGenerators(
  domain: DomainConfig,
  data: Record<string, Record<string, unknown>[]>,
): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
    const rows = data[entityName] ?? [];
    out[entityName] = rows.map((row) => applyFieldGeneratorsToRow(entityCfg, row, entityName));
  }
  return out;
}

export function validateDomainAvatarConfigs(domain: DomainConfig): void {
  for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
    for (const [fieldName, fieldCfg] of Object.entries(entityCfg.fields)) {
      if (!fieldCfg.avatar) continue;
      const style = fieldCfg.avatar.style ?? 'toon-head';
      if (!AvatarGenerator.IsStyle(style)) {
        throw new Error(`${entityName}.${fieldName}: avatar.style '${style}' is not toon-head, micah, or lorelei`);
      }
      const traits = fieldCfg.avatar.traits ?? {};
      for (const [traitKey, opts] of Object.entries(traits)) {
        AvatarGenerator.ValidateStyleOptions(style, opts as Record<string, unknown>);
        void traitKey;
      }
    }
  }
}
