export interface AssignmentRule<TValue> {
  when?: Record<string, unknown>;
  whenAbove?: Record<string, number>;
  value: TValue;
}

/**
 * Pattern 5: staticAssignment
 * Pure deterministic assignment from ordered conditional rules over driver context.
 */
export function staticAssignment<TValue>(
  rules: readonly AssignmentRule<TValue>[],
  ctx: Record<string, unknown>
): TValue {
  for (const rule of rules) {
    const eqMatch =
      !rule.when ||
      Object.entries(rule.when).every(([k, v]) => ctx[k] === v);

    const gtMatch =
      !rule.whenAbove ||
      Object.entries(rule.whenAbove).every(
        ([k, v]) => typeof ctx[k] === 'number' && (ctx[k] as number) > v
      );

    if (eqMatch && gtMatch) {
      return rule.value;
    }
  }

  throw new Error('staticAssignment: no rule matched and no default rule was provided');
}
