import { z } from 'zod';

export const FactorAdjustmentSchema = z.object({
  factor: z.string().min(1),
  deltaIntercept: z.number(),
}).strict();
export type FactorAdjustment = z.infer<typeof FactorAdjustmentSchema>;

export const VolumeMultiplierSchema = z.object({
  entity: z.string().min(1),
  multiplier: z.number().min(0),
  where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict();
export type VolumeMultiplier = z.infer<typeof VolumeMultiplierSchema>;

export const EraConfigSchema = z.object({
  eraKey: z.string().min(1),
  scope: z.literal('all').default('all'),
  cycles: z.array(z.number().int()).min(1),
  factorAdjustments: z.array(FactorAdjustmentSchema).default([]),
  volumeMultipliers: z.array(VolumeMultiplierSchema).default([]),
  description: z.string().optional(),
}).strict();
export type EraConfig = z.infer<typeof EraConfigSchema>;

export const ErasManifestSchema = z.object({
  $schema: z.string().optional(),
  eras: z.array(EraConfigSchema),
}).strict();
export type ErasManifest = z.infer<typeof ErasManifestSchema>;
