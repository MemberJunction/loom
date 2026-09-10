/**
 * AvatarGenerator — DiceBear collection adapter (loom #12 WP2).
 *
 * Offline SVG via @dicebear/core + a licensed collection, then svgo.
 * Trait → collection options is declarative (domain.json `traits`).
 * Option keys and values are checked against `collection.schema`.
 */
import { createAvatar, type Style } from '@dicebear/core';
import * as toonHead from '@dicebear/toon-head';
import * as micah from '@dicebear/micah';
import * as lorelei from '@dicebear/lorelei';
import { optimize } from 'svgo';

export type DiceBearStyle = 'toon-head' | 'micah' | 'lorelei';

/** The value shapes DiceBear collection schemas declare: enum arrays, colour arrays, integer probabilities. */
export type StyleOptionValue = string | number | boolean | string[];
export type StyleOptions = Record<string, StyleOptionValue>;
export type StyleOptionsMap = Record<string, StyleOptions>;

/**
 * Pinned DiceBear package and CDN version for deterministic avatar rendering.
 */
export const DEFAULT_DICEBEAR_VERSION = '9.4.2';

/**
 * Calibrated 7-step natural skin tone spectrum (warm peach to rich warm cocoa).
 * Narrowed to avoid overly dark, muddy tones (such as default #5c3829) while preserving natural diversity.
 */
export const REALISTIC_SKIN_TONES = [
  'f1c3a5', // fair warm peach
  'e8be9e', // light natural beige
  'd4a37a', // warm honey sand
  'c68e7a', // rosy warm tan
  'b98e6a', // golden bronze
  'a36b4f', // warm caramel / chestnut
  '8f5638', // rich warm cocoa
] as const;

/**
 * Curated trait constraints for the `toon-head` style pack.
 * Enforces gender-appropriate hair / facial hair, clothing styles, cheerful facial expressions,
 * and realistic calibrated skin tones.
 */
export const RECOMMENDED_TOON_HEAD_TRAITS: StyleOptionsMap = {
  Female: {
    hair: ['bun', 'sideComed'],
    hairProbability: 100,
    rearHair: ['longStraight', 'longWavy', 'shoulderHigh'],
    rearHairProbability: 100,
    beardProbability: 0,
    clothes: ['dress', 'turtleNeck', 'shirt', 'tShirt', 'openJacket'],
    mouth: ['smile', 'laugh'],
    eyes: ['happy', 'wide'],
    eyebrows: ['happy', 'neutral', 'raised'],
    skinColor: [...REALISTIC_SKIN_TONES],
  },
  Male: {
    hair: ['sideComed', 'undercut'],
    hairProbability: 100,
    rearHairProbability: 0,
    beardProbability: 20,
    clothes: ['shirt', 'tShirt', 'turtleNeck', 'openJacket'],
    mouth: ['smile', 'laugh'],
    eyes: ['happy', 'wide'],
    eyebrows: ['happy', 'neutral', 'raised'],
    skinColor: [...REALISTIC_SKIN_TONES],
  },
};

export interface AvatarOptions {
  seed: string;
  trait?: string;
  traits?: StyleOptionsMap;
  defaultTrait?: string;
  style?: DiceBearStyle;
  format?: 'base64' | 'svg' | 'url';
  backgroundColor?: string;
  maxLength?: number;
  version?: string;
}

const DICEBEAR_STYLES: Record<DiceBearStyle, Style<object>> = {
  'toon-head': toonHead as Style<object>,
  micah: micah as Style<object>,
  lorelei: lorelei as Style<object>,
};

interface StyleOptionSchema {
  type?: string;
  items?: { type?: string; enum?: string[] };
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

const CORE_OPTION_KEYS = new Set([
  'seed',
  'flip',
  'rotate',
  'scale',
  'radius',
  'size',
  'backgroundColor',
  'backgroundType',
  'backgroundRotation',
  'translateX',
  'translateY',
  'clip',
  'randomizeIds',
]);

export class AvatarGenerator {
  public static IsStyle(value: string | undefined): value is DiceBearStyle {
    return value === 'toon-head' || value === 'micah' || value === 'lorelei';
  }

  public static Collection(style: DiceBearStyle): Style<object> {
    return DICEBEAR_STYLES[style];
  }

  public static ResolveStyleOptions(options: AvatarOptions): StyleOptions {
    const traits = options.traits;
    if (!traits) return {};
    const raw = (options.trait ?? '').trim();
    if (raw) {
      if (traits[raw]) return traits[raw]!;
      const lower = raw.toLowerCase();
      for (const [k, v] of Object.entries(traits)) {
        if (k.toLowerCase() === lower) return v;
      }
    }
    const fallback = (options.defaultTrait ?? '').trim();
    if (!fallback) return {};
    const fallbackOptions = traits[fallback];
    if (!fallbackOptions) {
      throw new Error(`AvatarGenerator: defaultTrait '${fallback}' is not a key of traits (${Object.keys(traits).join(', ')})`);
    }
    return fallbackOptions;
  }

  public static ValidateStyleOptions(style: DiceBearStyle, styleOptions: StyleOptions): void {
    const schema = DICEBEAR_STYLES[style].schema as
      | { properties?: Record<string, StyleOptionSchema> }
      | undefined;
    const props = schema?.properties ?? {};
    for (const [key, value] of Object.entries(styleOptions)) {
      if (CORE_OPTION_KEYS.has(key)) continue;
      const prop = props[key];
      if (!prop) {
        throw new Error(`AvatarGenerator: unknown option '${key}' for style '${style}'`);
      }
      this.validateStyleOptionType(style, key, value, prop);
      if (Array.isArray(value)) {
        const allowed = prop.items?.enum;
        if (allowed) {
          for (const entry of value) {
            if (!allowed.includes(String(entry))) {
              throw new Error(
                `AvatarGenerator: invalid value '${entry}' for '${style}.${key}' (allowed: ${allowed.join(', ')})`,
              );
            }
          }
        }
      } else if (typeof value === 'string' && prop.enum && !prop.enum.includes(value)) {
        throw new Error(
          `AvatarGenerator: invalid value '${value}' for '${style}.${key}' (allowed: ${prop.enum.join(', ')})`,
        );
      } else if (typeof value === 'number' && prop.type === 'integer') {
        if (prop.minimum !== undefined && value < prop.minimum) {
          throw new Error(`AvatarGenerator: ${style}.${key}=${value} below minimum ${prop.minimum}`);
        }
        if (prop.maximum !== undefined && value > prop.maximum) {
          throw new Error(`AvatarGenerator: ${style}.${key}=${value} above maximum ${prop.maximum}`);
        }
      }
    }
  }

  /**
   * The schema's `type` is authoritative. A string where the collection wants an array
   * (`hair: 'long'`) or a string where it wants an integer (`beardProbability: '40'`) is
   * accepted by DiceBear without complaint and silently renders something else, which is
   * exactly the misconfiguration this validator exists to refuse.
   */
  private static validateStyleOptionType(
    style: DiceBearStyle,
    key: string,
    value: StyleOptionValue,
    prop: StyleOptionSchema,
  ): void {
    const expected = prop.type;
    if (!expected) return;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    let ok: boolean;
    switch (expected) {
      case 'array':
        ok = Array.isArray(value) && value.every((v) => typeof v === 'string');
        break;
      case 'integer':
        ok = typeof value === 'number' && Number.isInteger(value);
        break;
      case 'number':
        ok = typeof value === 'number';
        break;
      default:
        ok = actual === expected;
    }
    if (!ok) {
      throw new Error(`AvatarGenerator: ${style}.${key} must be ${expected}, got ${actual} (${JSON.stringify(value)})`);
    }
  }

  public static Generate(options: AvatarOptions): string {
    const format = options.format ?? 'base64';
    const style = options.style ?? 'toon-head';
    if (!this.IsStyle(style)) {
      throw new Error(
        `AvatarGenerator: style '${String(style)}' is not an offline DiceBear collection. ` +
          `Use 'toon-head' (recommended), 'micah', or 'lorelei'.`,
      );
    }
    if (format === 'url') {
      return this.BuildUrl(options);
    }
    const styleOptions = this.ResolveStyleOptions(options);
    this.ValidateStyleOptions(style, styleOptions);
    const svg = this.BuildDiceBearSvg(options.seed, style, styleOptions, options.backgroundColor);
    const out = format === 'svg' ? svg : 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    if (options.maxLength !== undefined && out.length > options.maxLength) {
      throw new Error(
        `AvatarGenerator: output length ${out.length} exceeds maxLength ${options.maxLength} (style=${style}, seed=${options.seed})`,
      );
    }
    return out;
  }

  public static BuildUrl(options: AvatarOptions): string {
    const style = options.style ?? 'toon-head';
    if (!this.IsStyle(style)) {
      throw new Error(
        `AvatarGenerator: style '${String(style)}' is not an offline DiceBear collection. ` +
          `Use 'toon-head' (recommended), 'micah', or 'lorelei'.`,
      );
    }
    const styleOptions = this.ResolveStyleOptions(options);
    this.ValidateStyleOptions(style, styleOptions);
    const params = new URLSearchParams();
    params.set('seed', options.seed);
    if (options.backgroundColor) {
      params.set('backgroundColor', options.backgroundColor.replace('#', ''));
    }
    for (const [key, value] of Object.entries(styleOptions)) {
      if (Array.isArray(value)) params.set(key, value.map(String).join(','));
      else if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const version = options.version ?? DEFAULT_DICEBEAR_VERSION;
    return `https://api.dicebear.com/${version}/${style}/svg?${params.toString()}`;
  }

  private static BuildDiceBearSvg(
    seed: string,
    style: DiceBearStyle,
    styleOptions: Record<string, unknown>,
    backgroundColor?: string,
  ): string {
    const collection = DICEBEAR_STYLES[style];
    const opts: Record<string, unknown> = { seed, ...styleOptions };
    if (backgroundColor) {
      opts.backgroundColor = [backgroundColor.replace('#', '')];
    }
    const avatar = createAvatar(collection, opts);
    const raw = avatar.toString();
    const min = optimize(raw, { multipass: true, plugins: ['preset-default'] });
    return min.data;
  }
}
