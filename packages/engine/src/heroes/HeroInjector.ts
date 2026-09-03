import type {
  HeroConfig,
  HeroPin,
  HeroFieldPin,
  HeroOutcomePin,
  HeroFeaturePin,
  PinOp,
  PinPrimitiveValue,
} from '@memberjunction/loom-contracts';
import { IdentityService } from '../identity/index.js';
import { compileRawFeature, type RelationalContext } from '../features/compiler.js';

export interface InjectedHeroRecord {
  id: string;
  heroKey: string;
  entity: string;
  birthCycle: number;
  eras: string[];
  latentDials: Record<string, number>;
  fixedFields: Record<string, string | number | boolean | null>;
  ladderEntries: HeroConfig['ladderEntries'];
  pins: HeroPin[];
  description?: string;
}

/**
 * Injects deterministic hero personas into the simulation population.
 * Guarantees Invariant 1 (Deterministic ID minting via UUIDv5) and
 * Invariant 2 (Zero-LLM mathematical conditioning).
 */
export class HeroInjector {
  private heroMap = new Map<string, InjectedHeroRecord>();
  private heroById = new Map<string, InjectedHeroRecord>();

  constructor(
    public readonly domain: string,
    public readonly namespaceUuid: string,
    heroes: HeroConfig[] = []
  ) {
    for (const hero of heroes) {
      this.RegisterHero(hero);
    }
  }

  /**
   * Registers and injects a single hero persona.
   */
  public RegisterHero(hero: HeroConfig): InjectedHeroRecord {
    const keyVals = Object.values(hero.businessKeys).map(String);
    const id = IdentityService.DeterministicId(this.namespaceUuid, hero.entity, keyVals);

    const record: InjectedHeroRecord = {
      id,
      heroKey: hero.heroKey,
      entity: hero.entity,
      birthCycle: hero.birthCycle,
      eras: [...(hero.eras ?? [])],
      latentDials: { ...(hero.latentDials ?? {}) },
      fixedFields: { ...(hero.fixedFields ?? {}) },
      ladderEntries: [...(hero.ladderEntries ?? [])],
      pins: [...(hero.pins ?? [])],
      description: hero.description,
    };

    this.heroMap.set(hero.heroKey, record);
    this.heroById.set(id, record);
    return record;
  }

  public GetHero(heroKey: string): InjectedHeroRecord | undefined {
    return this.heroMap.get(heroKey);
  }

  public GetHeroById(id: string): InjectedHeroRecord | undefined {
    return this.heroById.get(id);
  }

  public GetAllHeroes(): InjectedHeroRecord[] {
    return Array.from(this.heroMap.values());
  }

  /**
   * Evaluates if a hero persona has a deterministic outcome pin for a factor at a given cycle.
   * If an outcome pin exists, returns the boolean outcome directly, bypassing stochastic draws.
   */
  public GetOutcomePin(
    heroKey: string,
    factorId: string,
    cycle: number
  ): boolean | undefined {
    const hero = this.heroMap.get(heroKey);
    if (!hero) return undefined;

    const pin = hero.pins.find(
      (p): p is HeroOutcomePin =>
        p.kind === 'outcome' && p.factor === factorId && p.cycle === cycle
    );

    return pin ? pin.value : undefined;
  }

  /**
   * Evaluates an operator predicate against a realized record value.
   */
  public static EvaluatePinOp(
    op: PinOp,
    actual: unknown,
    expected: PinPrimitiveValue | PinPrimitiveValue[]
  ): boolean {
    switch (op) {
      case 'eq':
        return actual === expected;
      case 'ne':
      case 'neq':
        return actual !== expected;
      case 'gt':
        return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
      case 'gte':
        return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
      case 'lt':
        return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
      case 'lte':
        return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
      case 'in':
        if (Array.isArray(expected)) {
          return (expected as unknown[]).includes(actual);
        }
        return false;
      case 'exists':
        if (typeof expected === 'boolean') {
          return expected ? actual !== undefined && actual !== null : actual === undefined || actual === null;
        }
        return actual !== undefined && actual !== null;
      case 'withinCyclesOfAsOf':
        if (typeof actual === 'number' && typeof expected === 'number') {
          return Math.abs(actual) <= expected;
        }
        return false;
      default:
        return false;
    }
  }

  /**
   * Validates all field pins for a hero record against a realized row.
   */
  public ValidateFieldPins(
    heroKey: string,
    row: Record<string, unknown>
  ): { valid: boolean; failedPins: HeroFieldPin[] } {
    const hero = this.heroMap.get(heroKey);
    if (!hero) {
      return { valid: false, failedPins: [] };
    }

    const fieldPins = hero.pins.filter((p): p is HeroFieldPin => p.kind === 'field');
    const failedPins: HeroFieldPin[] = [];

    for (const pin of fieldPins) {
      const actual = row[pin.field];
      if (!HeroInjector.EvaluatePinOp(pin.op, actual, pin.value)) {
        failedPins.push(pin);
      }
    }

    return {
      valid: failedPins.length === 0,
      failedPins,
    };
  }

  /**
   * Validates feature pins for a hero record against a realized entity and relational context.
   * Fulfills Gate 0 verification using compileRawFeature.
   */
  public ValidateFeaturePins(
    heroKey: string,
    row: Record<string, unknown>,
    context?: RelationalContext
  ): { valid: boolean; failedPins: HeroFeaturePin[] } {
    const hero = this.heroMap.get(heroKey);
    if (!hero) {
      return { valid: false, failedPins: [] };
    }

    const featurePins = hero.pins.filter((p): p is HeroFeaturePin => p.kind === 'feature');
    const failedPins: HeroFeaturePin[] = [];

    for (const pin of featurePins) {
      const evaluator = compileRawFeature(pin.feature);
      const actual = evaluator(row, context);
      if (!HeroInjector.EvaluatePinOp(pin.op, actual, pin.value)) {
        failedPins.push(pin);
      }
    }

    return {
      valid: failedPins.length === 0,
      failedPins,
    };
  }
}
