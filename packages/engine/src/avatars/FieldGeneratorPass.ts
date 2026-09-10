import type { DomainConfig, EntityConfig } from '@memberjunction/loom-contracts';
import { AvatarGenerator } from './AvatarGenerator.js';
import { LogoGenerator } from './LogoGenerator.js';

import {
  applyDeclarativeGeneratorsToRow,
  type GeneratorContext,
} from '../generators/DeclarativeGenerators.js';
import { createRng } from '../math/rng.js';

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
  context?: Partial<GeneratorContext>,
): Record<string, unknown> {
  const seedVal = fieldValue(row, 'ID') ?? `${entityName}`;
  const rng = context?.rng ?? createRng(42, `gen:${entityName}:${String(seedVal)}`);
  const genCtx: GeneratorContext = {
    parent: context?.parent,
    parentPool: context?.parentPool,
    catalogs: context?.catalogs,
    asOfDate: context?.asOfDate,
    rng,
  };

  const next = applyDeclarativeGeneratorsToRow(entityCfg, row, genCtx);

  for (const [fieldName, fieldCfg] of Object.entries(entityCfg.fields)) {
    if (fieldCfg.avatar) {
      const cfg = fieldCfg.avatar;
      const seed = fieldValue(next, cfg.seedField || 'ID') ?? `${entityName}`;
      const traitRaw = cfg.traitField ? fieldValue(next, cfg.traitField) : undefined;
      next[fieldName] = AvatarGenerator.Generate({
        seed: String(seed),
        trait: traitRaw !== undefined && traitRaw !== null ? String(traitRaw) : undefined,
        traits: cfg.traits,
        defaultTrait: cfg.defaultTrait,
        style: cfg.style,
        format: cfg.format,
        backgroundColor: cfg.backgroundColor,
        maxLength: cfg.maxLength ?? fieldCfg.maxLength,
      });
    } else if (fieldCfg.logo) {
      const cfg = fieldCfg.logo;
      const nameVal = fieldValue(next, cfg.nameField || 'Name') ?? entityName;
      const seed = fieldValue(next, cfg.seedField || 'ID') ?? nameVal;
      next[fieldName] = LogoGenerator.Generate({
        name: String(nameVal),
        seed: String(seed),
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
  context?: Partial<GeneratorContext>,
): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
    const rows = data[entityName] ?? [];
    out[entityName] = rows.map((row) =>
      applyFieldGeneratorsToRow(entityCfg, row, entityName, {
        ...context,
        parentPool: data,
      }),
    );
  }
  return out;
}

/**
 * Fail at `loom build` / `loom decorate` load time, not per record: an unknown style, a
 * trait option the collection schema rejects, a `traitField` with nothing to map it to, or a
 * `defaultTrait` that names no key would otherwise degrade silently to seed-only avatars.
 */
export function validateDomainAvatarConfigs(domain: DomainConfig): void {
  for (const [entityName, entityCfg] of Object.entries(domain.entities)) {
    for (const [fieldName, fieldCfg] of Object.entries(entityCfg.fields)) {
      if (!fieldCfg.avatar) continue;
      const where = `${entityName}.${fieldName}`;
      const { style, traits, traitField, defaultTrait } = fieldCfg.avatar;
      if (!AvatarGenerator.IsStyle(style)) {
        throw new Error(`${where}: avatar.style '${style}' is not toon-head, micah, or lorelei`);
      }
      const traitKeys = Object.keys(traits ?? {});
      if (traitField && traitKeys.length === 0) {
        throw new Error(`${where}: avatar.traitField '${traitField}' is set but avatar.traits declares no mapping, so the trait would be ignored`);
      }
      if (defaultTrait !== undefined && !traitKeys.includes(defaultTrait)) {
        throw new Error(`${where}: avatar.defaultTrait '${defaultTrait}' is not a key of avatar.traits (${traitKeys.join(', ') || 'none'})`);
      }
      for (const opts of Object.values(traits ?? {})) {
        AvatarGenerator.ValidateStyleOptions(style, opts);
      }
    }
  }
}
