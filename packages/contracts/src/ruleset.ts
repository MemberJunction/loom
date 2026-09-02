import { z } from 'zod';
import { FactorContractSchema } from './factors.js';

export const WeightedOptionSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  weight: z.number().nonnegative(),
  description: z.string().optional(),
});
export type WeightedOption = z.infer<typeof WeightedOptionSchema>;

export const RulesetModuleSchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  catalog: z.record(z.string(), z.unknown()).default({}),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  effects: z.record(z.string(), FactorContractSchema).default({}),
  mixes: z.record(z.string(), z.array(WeightedOptionSchema)).default({}),
});
export type RulesetModule = z.infer<typeof RulesetModuleSchema>;

export const CompleteRulesetSchema = z.object({
  modules: z.record(z.string(), RulesetModuleSchema),
  scenarios: z.record(z.string(), z.record(z.string(), z.number())).default({}),
});
export type CompleteRuleset = z.infer<typeof CompleteRulesetSchema>;
