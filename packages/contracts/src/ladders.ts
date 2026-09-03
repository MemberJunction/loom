import { z } from 'zod';

export const StateLadderFieldBindingSchema = z.object({
  mode: z.literal('field'),
  field: z.string().min(1),
}).strict();
export type StateLadderFieldBinding = z.infer<typeof StateLadderFieldBindingSchema>;

export const StateLadderChildEntityBindingSchema = z.object({
  mode: z.literal('childEntity'),
  childEntity: z.string().min(1),
  foreignKey: z.string().min(1),
  stateField: z.string().min(1),
  termField: z.string().min(1).optional(),
  startDateField: z.string().min(1).optional(),
  endDateField: z.string().min(1).optional(),
}).strict();
export type StateLadderChildEntityBinding = z.infer<typeof StateLadderChildEntityBindingSchema>;

export const StateLadderBindingSchema = z.discriminatedUnion('mode', [
  StateLadderFieldBindingSchema,
  StateLadderChildEntityBindingSchema,
]);
export type StateLadderBinding = z.infer<typeof StateLadderBindingSchema>;

export const LadderEffectSchema = z.object({
  factor: z.string().min(1),
  beta: z.number(),
}).strict();
export type LadderEffect = z.infer<typeof LadderEffectSchema>;

export const LadderExitEffectSchema = z.object({
  dial: z.string().min(1),
  delta: z.number(),
}).strict();
export type LadderExitEffect = z.infer<typeof LadderExitEffectSchema>;

export const StateLadderPrerequisiteSchema = z.object({
  priorState: z.string().optional(),
  minCyclesSinceBirth: z.number().int().optional(),
  dials: z.record(
    z.string(),
    z.object({
      min: z.number().optional(),
      max: z.number().optional(),
    }).strict()
  ).optional(),
}).strict();
export type StateLadderPrerequisite = z.infer<typeof StateLadderPrerequisiteSchema>;

export const StateLadderStateSchema = z.object({
  name: z.string().min(1),
  durationCycles: z.number().int().min(1).default(1),
  capacity: z.number().int().min(1).optional(),
  prerequisites: StateLadderPrerequisiteSchema.optional(),
  effects: z.array(LadderEffectSchema).default([]),
  exitEffects: z.array(LadderExitEffectSchema).default([]),
}).strict();
export type StateLadderState = z.infer<typeof StateLadderStateSchema>;

export const StateLadderConfigSchema = z.object({
  ladderKey: z.string().min(1),
  entity: z.string().min(1),
  binding: StateLadderBindingSchema,
  cohortShare: z.number().min(0).max(1).default(1),
  states: z.array(StateLadderStateSchema).min(1),
  description: z.string().optional(),
}).strict();
export type StateLadderConfig = z.infer<typeof StateLadderConfigSchema>;

export const LaddersManifestSchema = z.object({
  $schema: z.string().optional(),
  ladders: z.array(StateLadderConfigSchema),
}).strict();
export type LaddersManifest = z.infer<typeof LaddersManifestSchema>;
