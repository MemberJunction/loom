import { DomainConfigSchema, type DomainConfig } from './domain.js';
import { HeroesManifestSchema, type HeroesManifest } from './heroes.js';
import { MotifsManifestSchema, type MotifsManifest } from './motifs.js';
import { LaddersManifestSchema, type LaddersManifest } from './ladders.js';
import { ErasManifestSchema, type ErasManifest } from './eras.js';

export interface DomainValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a hero persona manifest against a DomainConfig schema.
 * Parses input with strict Zod schemas first, then verifies all entities,
 * fixed fields, and pin predicates against declared domain entities.
 */
export function validateHeroesAgainstDomain(
  rawManifest: unknown,
  rawDomain: unknown
): DomainValidationResult {
  const errors: string[] = [];

  const domainParsed = DomainConfigSchema.safeParse(rawDomain);
  if (!domainParsed.success) {
    return {
      valid: false,
      errors: domainParsed.error.issues.map((i) => `DomainConfig: ${i.path.join('.')}: ${i.message}`),
    };
  }
  const domain: DomainConfig = domainParsed.data;

  const manifestParsed = HeroesManifestSchema.safeParse(rawManifest);
  if (!manifestParsed.success) {
    return {
      valid: false,
      errors: manifestParsed.error.issues.map((i) => `HeroesManifest: ${i.path.join('.')}: ${i.message}`),
    };
  }
  const manifest: HeroesManifest = manifestParsed.data;

  for (const hero of manifest.heroes) {
    const entityCfg = domain.entities[hero.entity];
    if (!entityCfg) {
      errors.push(`Hero '${hero.heroKey}': unknown target entity '${hero.entity}'`);
      continue;
    }

    // Check fixed fields
    for (const fieldName of Object.keys(hero.fixedFields)) {
      if (!entityCfg.fields[fieldName]) {
        errors.push(`Hero '${hero.heroKey}': unknown field '${hero.entity}.${fieldName}' in fixedFields`);
      }
    }

    // Check pins
    for (const pin of hero.pins) {
      if (pin.kind === 'field') {
        if (!entityCfg.fields[pin.field]) {
          errors.push(`Hero '${hero.heroKey}': unknown field '${hero.entity}.${pin.field}' in field pin`);
        }
      } else if (pin.kind === 'feature') {
        const feat = pin.feature;
        if (feat.from === 'self') {
          if (feat.field && !entityCfg.fields[feat.field]) {
            errors.push(`Hero '${hero.heroKey}': unknown field '${hero.entity}.${feat.field}' in self feature pin`);
          }
          if (feat.where) {
            for (const whereField of Object.keys(feat.where)) {
              if (!entityCfg.fields[whereField]) {
                errors.push(`Hero '${hero.heroKey}': unknown field '${hero.entity}.${whereField}' in self feature pin where criteria`);
              }
            }
          }
        } else {
          const targetChild = domain.entities[feat.from];
          if (!targetChild) {
            errors.push(`Hero '${hero.heroKey}': unknown entity '${feat.from}' in feature pin`);
          } else {
            if (feat.field && !targetChild.fields[feat.field]) {
              errors.push(`Hero '${hero.heroKey}': unknown field '${feat.from}.${feat.field}' in feature pin`);
            }
            if (feat.where) {
              for (const whereField of Object.keys(feat.where)) {
                if (!targetChild.fields[whereField]) {
                  errors.push(`Hero '${hero.heroKey}': unknown field '${feat.from}.${whereField}' in feature pin where criteria`);
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates a motifs manifest against a DomainConfig schema.
 */
export function validateMotifsAgainstDomain(
  rawManifest: unknown,
  rawDomain: unknown
): DomainValidationResult {
  const errors: string[] = [];

  const domainParsed = DomainConfigSchema.safeParse(rawDomain);
  if (!domainParsed.success) {
    return {
      valid: false,
      errors: domainParsed.error.issues.map((i) => `DomainConfig: ${i.path.join('.')}: ${i.message}`),
    };
  }
  const domain: DomainConfig = domainParsed.data;

  const manifestParsed = MotifsManifestSchema.safeParse(rawManifest);
  if (!manifestParsed.success) {
    return {
      valid: false,
      errors: manifestParsed.error.issues.map((i) => `MotifsManifest: ${i.path.join('.')}: ${i.message}`),
    };
  }
  const manifest: MotifsManifest = manifestParsed.data;

  for (const motif of manifest.motifs) {
    const entityCfg = domain.entities[motif.targetEntity];
    if (!entityCfg) {
      errors.push(`Motif '${motif.motifKey}': unknown target entity '${motif.targetEntity}'`);
      continue;
    }

    if (motif.fixedFields) {
      for (const fieldName of Object.keys(motif.fixedFields)) {
        if (!entityCfg.fields[fieldName]) {
          errors.push(`Motif '${motif.motifKey}': unknown field '${motif.targetEntity}.${fieldName}' in fixedFields`);
        }
      }
    }

    for (const childRate of motif.childRates ?? []) {
      if (!domain.entities[childRate.entity]) {
        errors.push(`Motif '${motif.motifKey}': unknown child entity '${childRate.entity}' in childRates`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates a ladders manifest against a DomainConfig schema.
 */
export function validateLaddersAgainstDomain(
  rawManifest: unknown,
  rawDomain: unknown
): DomainValidationResult {
  const errors: string[] = [];

  const domainParsed = DomainConfigSchema.safeParse(rawDomain);
  if (!domainParsed.success) {
    return {
      valid: false,
      errors: domainParsed.error.issues.map((i) => `DomainConfig: ${i.path.join('.')}: ${i.message}`),
    };
  }
  const domain: DomainConfig = domainParsed.data;

  const manifestParsed = LaddersManifestSchema.safeParse(rawManifest);
  if (!manifestParsed.success) {
    return {
      valid: false,
      errors: manifestParsed.error.issues.map((i) => `LaddersManifest: ${i.path.join('.')}: ${i.message}`),
    };
  }
  const manifest: LaddersManifest = manifestParsed.data;

  for (const ladder of manifest.ladders) {
    const entityCfg = domain.entities[ladder.entity];
    if (!entityCfg) {
      errors.push(`Ladder '${ladder.ladderKey}': unknown target entity '${ladder.entity}'`);
      continue;
    }

    if (ladder.binding.mode === 'field') {
      if (!entityCfg.fields[ladder.binding.field]) {
        errors.push(`Ladder '${ladder.ladderKey}': unknown field '${ladder.entity}.${ladder.binding.field}' in field binding`);
      }
    } else if (ladder.binding.mode === 'childEntity') {
      const childCfg = domain.entities[ladder.binding.childEntity];
      if (!childCfg) {
        errors.push(`Ladder '${ladder.ladderKey}': unknown child entity '${ladder.binding.childEntity}' in childEntity binding`);
      } else {
        if (!childCfg.fields[ladder.binding.foreignKey]) {
          errors.push(`Ladder '${ladder.ladderKey}': unknown foreign key '${ladder.binding.childEntity}.${ladder.binding.foreignKey}' in childEntity binding`);
        }
        if (!childCfg.fields[ladder.binding.stateField]) {
          errors.push(`Ladder '${ladder.ladderKey}': unknown state field '${ladder.binding.childEntity}.${ladder.binding.stateField}' in childEntity binding`);
        }
        if (ladder.binding.termField && !childCfg.fields[ladder.binding.termField]) {
          errors.push(`Ladder '${ladder.ladderKey}': unknown term field '${ladder.binding.childEntity}.${ladder.binding.termField}' in childEntity binding`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates an eras manifest against a DomainConfig schema.
 */
export function validateErasAgainstDomain(
  rawManifest: unknown,
  rawDomain: unknown
): DomainValidationResult {
  const errors: string[] = [];

  const domainParsed = DomainConfigSchema.safeParse(rawDomain);
  if (!domainParsed.success) {
    return {
      valid: false,
      errors: domainParsed.error.issues.map((i) => `DomainConfig: ${i.path.join('.')}: ${i.message}`),
    };
  }
  const domain: DomainConfig = domainParsed.data;

  const manifestParsed = ErasManifestSchema.safeParse(rawManifest);
  if (!manifestParsed.success) {
    return {
      valid: false,
      errors: manifestParsed.error.issues.map((i) => `ErasManifest: ${i.path.join('.')}: ${i.message}`),
    };
  }
  const manifest: ErasManifest = manifestParsed.data;

  for (const era of manifest.eras) {
    for (const vm of era.volumeMultipliers) {
      const entityCfg = domain.entities[vm.entity];
      if (!entityCfg) {
        errors.push(`Era '${era.eraKey}': unknown entity '${vm.entity}' in volumeMultipliers`);
      } else if (vm.where) {
        for (const whereField of Object.keys(vm.where)) {
          if (!entityCfg.fields[whereField]) {
            const resolvedThroughFk = Object.values(entityCfg.foreignKeys ?? {}).some((fk) => {
              if (fk.fieldName === whereField) return true;
              const targetEntityCfg = domain.entities[fk.targetEntity];
              return targetEntityCfg && Boolean(targetEntityCfg.fields[whereField]);
            });
            if (!resolvedThroughFk) {
              errors.push(
                `Era '${era.eraKey}': field '${whereField}' not found on entity '${vm.entity}' or its related entities in volumeMultipliers where condition`
              );
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
