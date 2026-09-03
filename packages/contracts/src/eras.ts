import { z } from 'zod';

export const EraScopeSchema = z.enum(['all', 'tagged']);
export type EraScope = z.infer<typeof EraScopeSchema>;

export const FactorAdjustmentSchema = z.object({
  factor: z.string().min(1),
  deltaIntercept: z.number(),
});
export type FactorAdjustment = z.infer<typeof FactorAdjustmentSchema>;

export const VolumeMultiplierSchema = z.object({
  entity: z.string().min(1),
  multiplier: z.number().nonnegative(),
});
export type VolumeMultiplier = z.infer<typeof VolumeMultiplierSchema>;

export const EraConfigSchema = z.object({
  eraKey: z.string().min(1),
  scope: EraScopeSchema,
  cycles: z.array(z.number().int()),
  factorAdjustments: z.array(FactorAdjustmentSchema).default([]),
  volumeMultipliers: z.array(VolumeMultiplierSchema).default([]) ,
  description: z.string().optional(),
});
export type EraConfig = z.infer<typeof EraConfigSchema>;

export const ErasManifestSchema = z.object({
  $schema: z.string().optional(),
  eras: z.array(EraConfigSchema),
});
export type ErasManifest = z.infer<typeof ErasManifestSchema>;
