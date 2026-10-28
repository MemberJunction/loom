import { z } from 'zod';

/**
 * A plan for one `loom accumulate` cycle: records decided outside Loom (by a person, or by a model that
 * read the dataset) that the cycle appends verbatim, plus per-entity intake overrides for the rows Loom
 * still generates itself. Loom mints the keys, resolves references and checks every field against the
 * domain; it never invents a value the plan supplied.
 */

/** A reference to another record in the same plan, by its `ref`. */
export const PlanRefSchema = z.object({ ref: z.string().min(1) }).strict();

/** A reference to exactly one record of the foreign key's target entity, existing or planned, matched on these fields. */
export const PlanLookupSchema = z
  .object({ lookup: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) })
  .strict()
  .refine((v) => Object.keys(v.lookup).length > 0, { message: 'lookup needs at least one field' });

export const PlanFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  PlanRefSchema,
  PlanLookupSchema,
]);
export type PlanFieldValue = z.infer<typeof PlanFieldValueSchema>;

export const PlanRecordSchema = z
  .object({
    /** Domain entity key, as in domain.json `entities`. */
    entity: z.string().min(1),
    /** Name other plan records use to point at this one. Unique within the plan. */
    ref: z.string().min(1).optional(),
    /** For an IsA child: the `ref` of the planned parent row it extends; the child takes the parent's key. */
    extends: z.string().min(1).optional(),
    fields: z.record(z.string(), PlanFieldValueSchema).default({}),
  })
  .strict();
export type PlanRecord = z.infer<typeof PlanRecordSchema>;

export const AccumulatePlanSchema = z
  .object({
    $schema: z.string().optional(),
    /** The cycle's as-of date. A plan only applies to the cycle it was written for. */
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'asOf must be YYYY-MM-DD'),
    /** Free text kept in the checkpoint: what the plan set out to do. */
    summary: z.string().optional(),
    /** Per-entity intake for this cycle, replacing the ruleset's intake_<Entity> for the rows Loom generates. */
    intake: z.record(z.string(), z.number().int().nonnegative()).default({}),
    records: z.array(PlanRecordSchema).default([]),
  })
  .strict();
export type AccumulatePlan = z.infer<typeof AccumulatePlanSchema>;
