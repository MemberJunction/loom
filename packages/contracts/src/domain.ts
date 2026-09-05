import { z } from 'zod';
import type { EntityInfo } from '@memberjunction/core';

export const FieldTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'date',
  'uuid',
  'json',
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const AvatarStyleSchema = z.enum(['toon-head', 'micah', 'lorelei']);
export const AvatarConfigSchema = z.object({
  style: AvatarStyleSchema.default('toon-head'),
  format: z.enum(['base64', 'svg', 'url']).default('base64'),
  traitField: z.string().optional(),
  seedField: z.string().default('ID'),
  /** trait value (e.g. Gender) → DiceBear collection options. Validated against collection.schema. */
  traits: z.record(z.record(z.unknown())).optional(),
  defaultTrait: z.string().optional(),
  backgroundColor: z.string().optional(),
  maxLength: z.number().int().positive().optional(),
});
export const LogoConfigSchema = z.object({
  format: z.enum(['base64', 'svg']).default('base64'),
  nameField: z.string().default('Name'),
  seedField: z.string().default('ID'),
  shape: z.enum(['auto', 'squircle', 'circle', 'hexagon']).default('auto'),
});
export type LogoConfig = z.infer<typeof LogoConfigSchema>;

export const FieldConfigSchema = z.object({
  name: z.string().min(1),
  type: FieldTypeSchema,
  nullable: z.boolean().default(false),
  description: z.string().optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  isPrimaryKey: z.boolean().default(false),
  mjFieldType: z.string().optional(),
  valueListType: z.string().optional(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  generator: z.string().optional(),
  avatar: AvatarConfigSchema.optional(),
  logo: LogoConfigSchema.optional(),
  uniqueness: z.enum(['generated']).optional(),
  maxLength: z.number().int().positive().optional(),
});
export type FieldConfig = z.infer<typeof FieldConfigSchema>;

export const ForeignKeyConfigSchema = z.object({
  fieldName: z.string().min(1).optional(),
  targetEntity: z.string().min(1),
  targetField: z.string().min(1),
  cardinality: z.enum(['one-to-one', 'many-to-one', 'one-to-many']).default('many-to-one'),
  dependent: z.boolean().default(false),
  lookupPattern: z.string().optional(),
});
export type ForeignKeyConfig = z.infer<typeof ForeignKeyConfigSchema>;

export const EntityConfigSchema = z.object({
  name: z.string().min(1),
  entityName: z.string().min(1),
  targetTable: z.string().min(1),
  schema: z.string().min(1),
  pack: z.string().min(1),
  businessKey: z.array(z.string()).min(1),
  fields: z.record(z.string(), FieldConfigSchema),
  foreignKeys: z.record(z.string(), ForeignKeyConfigSchema).default({}),
  isImmutable: z.boolean().default(false),
  outputDirectory: z.string().optional(),
  outputFileName: z.string().optional(),
}).transform((entity) => {
  const normalizedFKs: Record<string, Omit<ForeignKeyConfig, 'fieldName'> & { fieldName: string }> = {};
  for (const [fkKey, fk] of Object.entries(entity.foreignKeys)) {
    normalizedFKs[fkKey] = {
      ...fk,
      fieldName: fk.fieldName ?? fkKey,
    };
  }
  return {
    ...entity,
    foreignKeys: normalizedFKs,
  };
});
export type EntityConfig = z.infer<typeof EntityConfigSchema>;

export const PackConfigSchema = z.object({
  name: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  description: z.string().optional(),
});
export type PackConfig = z.infer<typeof PackConfigSchema>;

export const PathMatchRuleSchema = z.object({
  kind: z.literal('path-match'),
  name: z.string().min(1),
  sourceEntity: z.string().min(1),
  path: z.array(z.string()).min(1),
  sourceField: z.string().optional(),
  targetField: z.string().min(1),
  inclusion: z.object({
    poolEntity: z.string().min(1),
    poolItemField: z.string().min(1),
    poolContainerField: z.string().min(1),
    sourceItemField: z.string().min(1),
  }).optional(),
});
export type PathMatchRule = z.infer<typeof PathMatchRuleSchema>;

export type TimingDistributionContract =
  | { type: 'const'; days: number }
  | { type: 'uniformDays'; min: number; max: number }
  | { type: 'lognormalDays'; medianDays: number; sigma: number; minDays?: number; capDays?: number }
  | { type: 'mixture'; bands: readonly [TimingDistributionContract, number][] };

export const TimingDistributionSchema: z.ZodType<TimingDistributionContract> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('const'),
      days: z.number(),
    }),
    z.object({
      type: z.literal('uniformDays'),
      min: z.number(),
      max: z.number(),
    }),
    z.object({
      type: z.literal('lognormalDays'),
      medianDays: z.number(),
      sigma: z.number(),
      minDays: z.number().optional(),
      capDays: z.number().optional(),
    }),
    z.object({
      type: z.literal('mixture'),
      bands: z.array(z.tuple([TimingDistributionSchema, z.number()])),
    }),
  ])
);

export const RoleWindowConfigSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  startOffsetYears: z.number().optional(),
  durationYears: z.number().optional(),
});
export type RoleWindowConfig = z.infer<typeof RoleWindowConfigSchema>;

export const DateWindowRuleSchema = z.object({
  kind: z.literal('date-window'),
  name: z.string().min(1),
  sourceEntity: z.string().min(1),
  dateField: z.string().min(1),
  linkEntity: z.string().optional(),
  linkSourceField: z.string().optional(),
  linkTargetField: z.string().optional(),
  windowEntity: z.string().min(1),
  windowForeignKey: z.string().min(1),
  windowStartField: z.string().min(1),
  windowEndField: z.string().min(1),
  requireWindow: z.boolean().optional().default(false),
  timing: TimingDistributionSchema.optional(),
  roleWindows: z.array(RoleWindowConfigSchema).optional(),
});
export type DateWindowRule = z.infer<typeof DateWindowRuleSchema>;

export const TextContainsPathRuleSchema = z.object({
  kind: z.literal('text-contains-path'),
  name: z.string().min(1),
  sourceEntity: z.string().min(1),
  textField: z.string().min(1),
  path: z.array(z.string()).min(1),
  targetFields: z.array(z.string()).min(1),
  childReferences: z.object({
    childEntity: z.string().min(1),
    foreignKey: z.string().min(1),
    childField: z.string().min(1),
  }).optional(),
});
export type TextContainsPathRule = z.infer<typeof TextContainsPathRuleSchema>;

export const OutcomeDerivedFromBallotsRuleSchema = z.object({
  kind: z.literal('outcome-derived-from-ballots'),
  name: z.string().min(1),
  sourceEntity: z.string().min(1),
  outcomeField: z.string().min(1),
  ballotEntity: z.string().min(1),
  ballotDecisionForeignKey: z.string().min(1),
  ballotVoteField: z.string().min(1),
  positiveVoteValue: z.string().default('Yes'),
  negativeVoteValue: z.string().default('No'),
  abstainVoteValue: z.string().optional().default('Abstain'),
  passedOutcomeValue: z.string().default('Passed'),
  failedOutcomeValue: z.string().default('Failed'),
  tieOutcomeValue: z.string().optional().default('Failed'),
  quorum: z.number().optional().default(1),
  tieRule: z.enum(['Passed', 'Failed']).optional().default('Failed'),
  abstainHandling: z.enum(['ignore', 'count-toward-quorum']).optional().default('ignore'),
  rule: z.enum(['majority', 'supermajority-two-thirds', 'unanimous']).default('majority'),
  abstainRate: z.number().min(0).max(1).optional().default(0),
  categoricalWeights: z.object({
    Yes: z.number().min(0),
    No: z.number().min(0),
    Abstain: z.number().min(0).optional(),
  }).optional(),
});
export type OutcomeDerivedFromBallotsRule = z.infer<typeof OutcomeDerivedFromBallotsRuleSchema>;

export const RelationalRuleSchema = z.discriminatedUnion('kind', [
  PathMatchRuleSchema,
  DateWindowRuleSchema,
  TextContainsPathRuleSchema,
  OutcomeDerivedFromBallotsRuleSchema,
]);
export type RelationalRule = z.infer<typeof RelationalRuleSchema>;

export const DomainConfigSchema = z.object({
  name: z.string().min(1),
  namespace: z.string().uuid(),
  description: z.string().optional(),
  entities: z.record(z.string(), EntityConfigSchema),
  packs: z.record(z.string(), PackConfigSchema),
  relationalRules: z.array(RelationalRuleSchema).optional().default([]),
});
export type DomainConfig = z.infer<typeof DomainConfigSchema>;

export interface CreateDomainConfigOptions {
  defaultPack?: string;
  businessKeyMap?: Record<string, string[]>;
}

/**
 * Constructs a strongly-typed DomainConfig directly from MemberJunction EntityInfo instances.
 * Requires explicit or resolvable business keys; never fabricates fictitious field names.
 */
export function createDomainConfigFromMJEntities(
  entities: readonly EntityInfo[],
  namespace: string,
  domainName: string,
  options: CreateDomainConfigOptions = {}
): DomainConfig {
  const defaultPack = options.defaultPack ?? 'common';
  const entityConfigs: Record<string, EntityConfig> = {};
  const packs: Record<string, PackConfig> = {
    [defaultPack]: { name: defaultPack, dependsOn: [] },
  };

  for (const entity of entities) {
    const fields: Record<string, FieldConfig> = {};
    const foreignKeys: EntityConfig['foreignKeys'] = {};
    const candidateBusinessKeys: string[] = [];

    for (const field of entity.Fields ?? []) {
      const fieldType = mapMJTypeToFieldType(field.Type);
      const isPk = field.IsPrimaryKey ?? false;

      fields[field.Name] = {
        name: field.Name,
        type: fieldType,
        nullable: field.AllowsNull ?? false,
        defaultValue: field.DefaultValue ?? undefined,
        isPrimaryKey: isPk,
        mjFieldType: field.Type,
        valueListType: field.ValueListType ?? undefined,
      };

      if (!isPk && (field.Name.endsWith('Code') || field.Name.endsWith('Number') || field.Name === 'Name' || field.Name.endsWith('Key'))) {
        candidateBusinessKeys.push(field.Name);
      }

      if (field.RelatedEntity && field.RelatedEntityFieldName) {
        const fkKey = `FK_${entity.Name}_${field.Name}_${field.RelatedEntity}`;
        foreignKeys[fkKey] = {
          fieldName: field.Name,
          targetEntity: field.RelatedEntity,
          targetField: field.RelatedEntityFieldName,
          cardinality: 'many-to-one',
          dependent: false,
        };
      }
    }

    let businessKey: string[];
    if (options.businessKeyMap?.[entity.Name]) {
      businessKey = options.businessKeyMap[entity.Name]!;
    } else if (candidateBusinessKeys.length > 0) {
      businessKey = [candidateBusinessKeys[0]!];
    } else {
      throw new Error(
        `createDomainConfigFromMJEntities: Entity '${entity.Name}' does not have a detectable business key field. Please specify businessKeyMap['${entity.Name}'] in options.`
      );
    }

    entityConfigs[entity.Name] = {
      name: entity.Name,
      entityName: entity.Name,
      targetTable: entity.BaseTable ?? entity.Name,
      schema: entity.SchemaName ?? 'dbo',
      pack: defaultPack,
      businessKey,
      fields,
      foreignKeys,
      isImmutable: false,
    };
  }

  return {
    name: domainName,
    namespace,
    description: `Domain generated directly from MemberJunction EntityInfo metadata`,
    entities: entityConfigs,
    packs,
    relationalRules: [],
  };
}

function mapMJTypeToFieldType(mjType: string): FieldType {
  const t = mjType.toLowerCase();
  if (t.includes('int') || t.includes('money') || t.includes('decimal') || t.includes('numeric') || t.includes('float')) {
    return 'number';
  }
  if (t.includes('bit') || t.includes('bool')) {
    return 'boolean';
  }
  if (t.includes('date') || t.includes('time')) {
    return 'date';
  }
  if (t.includes('uniqueidentifier') || t.includes('uuid')) {
    return 'uuid';
  }
  return 'string';
}
