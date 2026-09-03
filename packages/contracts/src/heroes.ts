import { z } from 'zod';
import { FeatureQuerySchema } from './factors.js';

export const PinOpSchema = z.enum([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'exists',
  'withinCyclesOfAsOf',
]);
export type PinOp = z.infer<typeof PinOpSchema>;

export const PinPrimitiveValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
]);
export type PinPrimitiveValue = z.infer<typeof PinPrimitiveValueSchema>;

export const HeroFieldPinSchema = z.object({
  kind: z.literal('field'),
  field: z.string().min(1),
  op: PinOpSchema,
  value: PinPrimitiveValueSchema,
  description: z.string().optional(),
});
export type HeroFieldPin = z.infer<typeof HeroFieldPinSchema>;

export const HeroOutcomePinSchema = z.object({
  kind: z.literal('outcome'),
  factor: z.string().min(1),
  cycle: z.number().int(),
  value: z.boolean(),
  description: z.string().optional(),
});
export type HeroOutcomePin = z.infer<typeof HeroOutcomePinSchema>;

export const HeroFeaturePinSchema = z.object({
  kind: z.literal('feature'),
  feature: FeatureQuerySchema,
  op: PinOpSchema,
  value: PinPrimitiveValueSchema,
  description: z.string().optional(),
});
export type HeroFeaturePin = z.infer<typeof HeroFeaturePinSchema>;

export const HeroPinSchema = z.discriminatedUnion('kind', [
  HeroFieldPinSchema,
  HeroOutcomePinSchema,
  HeroFeaturePinSchema,
]);
export type HeroPin = z.infer<typeof HeroPinSchema>;

export const HeroLadderEntrySchema = z.object({
  ladderKey: z.string().min(1),
  state: z.string().min(1),
  enterCycle: z.number().int(),
  exitCycle: z.number().int(),
});
export type HeroLadderEntry = z.infer<typeof HeroLadderEntrySchema>;

export const HeroConfigSchema = z.object({
  heroKey: z.string().min(1),
  entity: z.string().min(1),
  businessKeys: z.record(z.string(), z.union([z.string(), z.number()])),
  fixedFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  birthCycle: z.number().int(),
  latentDials: z.record(z.string(), z.number()).default({}),
  ladderEntries: z.array(HeroLadderEntrySchema).default([]),
  eras: z.array(z.string()).default([]),
  pins: z.array(HeroPinSchema).default([]),
  description: z.string().optional(),
});
export type HeroConfig = z.infer<typeof HeroConfigSchema>;

export const HeroesManifestSchema = z.object({
  $schema: z.string().optional(),
  heroes: z.array(HeroConfigSchema),
});
export type HeroesManifest = z.infer<typeof HeroesManifestSchema>;
