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

export const FieldConfigSchema = z.object({
  name: z.string().min(1),
  type: FieldTypeSchema,
  nullable: z.boolean().default(false),
  description: z.string().optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  isPrimaryKey: z.boolean().default(false),
  mjFieldType: z.string().optional(),
  valueListType: z.string().optional(),
});
export type FieldConfig = z.infer<typeof FieldConfigSchema>;

export const ForeignKeyConfigSchema = z.object({
  fieldName: z.string().min(1),
  targetEntity: z.string().min(1),
  targetField: z.string().min(1),
  cardinality: z.enum(['one-to-one', 'many-to-one', 'one-to-many']).default('many-to-one'),
});
export type ForeignKeyConfig = z.infer<typeof ForeignKeyConfigSchema>;

export const EntityConfigSchema = z.object({
  name: z.string().min(1),
  targetTable: z.string().min(1),
  schema: z.string().min(1),
  pack: z.string().min(1),
  businessKey: z.array(z.string()).min(1),
  fields: z.record(z.string(), FieldConfigSchema),
  foreignKeys: z.record(z.string(), ForeignKeyConfigSchema).default({}),
  isImmutable: z.boolean().default(false),
});
export type EntityConfig = z.infer<typeof EntityConfigSchema>;

export const PackConfigSchema = z.object({
  name: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  description: z.string().optional(),
});
export type PackConfig = z.infer<typeof PackConfigSchema>;

export const DomainConfigSchema = z.object({
  name: z.string().min(1),
  namespace: z.string().uuid(),
  description: z.string().optional(),
  entities: z.record(z.string(), EntityConfigSchema),
  packs: z.record(z.string(), PackConfigSchema),
});
export type DomainConfig = z.infer<typeof DomainConfigSchema>;

/**
 * Constructs a strongly-typed DomainConfig directly from MemberJunction EntityInfo instances.
 * This directly binds Loom simulation models to live MemberJunction metadata.
 */
export function createDomainConfigFromMJEntities(
  entities: readonly EntityInfo[],
  namespace: string,
  domainName: string,
  defaultPack = 'common'
): DomainConfig {
  const entityConfigs: Record<string, EntityConfig> = {};
  const packs: Record<string, PackConfig> = {
    [defaultPack]: { name: defaultPack, dependsOn: [] },
  };

  for (const entity of entities) {
    const fields: Record<string, FieldConfig> = {};
    const foreignKeys: Record<string, ForeignKeyConfig> = {};
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

      // Identify non-PK business key candidates (e.g. Code, Name, Email, ExternalID)
      if (!isPk && (field.Name.endsWith('Code') || field.Name.endsWith('Number') || field.Name === 'Name' || field.Name.endsWith('Key'))) {
        candidateBusinessKeys.push(field.Name);
      }

      if (field.RelatedEntity && field.RelatedEntityFieldName) {
        // Disambiguate foreign key key by fieldName so multiple FKs to same entity don't collide
        const fkKey = `FK_${entity.Name}_${field.Name}_${field.RelatedEntity}`;
        foreignKeys[fkKey] = {
          fieldName: field.Name,
          targetEntity: field.RelatedEntity,
          targetField: field.RelatedEntityFieldName,
          cardinality: 'many-to-one',
        };
      }
    }

    // Never default businessKey to ['ID'], as that causes circular dependency during deterministic minting
    const businessKey = candidateBusinessKeys.length > 0
      ? [candidateBusinessKeys[0]!]
      : ['NaturalKey'];

    entityConfigs[entity.Name] = {
      name: entity.Name,
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
