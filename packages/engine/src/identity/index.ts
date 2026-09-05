import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v5 as uuidv5 } from 'uuid';

const catalog = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'given-names.json'), 'utf8'),
) as { female: string[]; male: string[] };

const FEMALE_NAMES = new Set(catalog.female.map((n) => n.toLowerCase()));
const MALE_NAMES = new Set(catalog.male.map((n) => n.toLowerCase()));

/**
 * Deterministic Identity Service.
 * Mints stable UUIDv5 primary keys from business keys and entity names.
 */
export class IdentityService {
  private namespaces = new Map<string, string>();

  /** Register a domain with its permanent UUID namespace */
  public RegisterNamespace(domain: string, namespaceUuid: string): void {
    this.namespaces.set(domain, namespaceUuid);
  }

  /** Retrieve the registered namespace for a domain */
  public GetNamespace(domain: string): string {
    const ns = this.namespaces.get(domain);
    if (!ns) {
      throw new Error(`IdentityService: no UUID namespace registered for domain '${domain}'`);
    }
    return ns;
  }

  /**
   * Mints a deterministic UUIDv5 for an entity record.
   * Format of name: "<EntityName>:<BusinessKey>"
   */
  public MintId(domain: string, entity: string, businessKey: string | readonly string[]): string {
    const ns = this.GetNamespace(domain);
    return IdentityService.DeterministicId(ns, entity, businessKey);
  }

  /**
   * Static deterministic ID generator for a given namespace UUID.
   */
  public static DeterministicId(
    namespaceUuid: string,
    entity: string,
    businessKey: string | readonly string[]
  ): string {
    const keyStr = Array.isArray(businessKey) ? businessKey.join('|') : String(businessKey);
    const identifier = `${entity}:${keyStr}`;
    return uuidv5(identifier, namespaceUuid);
  }

  /**
   * Catalog-backed given-name → Gender. Unknown when the name is not in the
   * catalog (loom #12 WP2). Same mapping the Name-Gender Consistency gate uses.
   */
  public static GenderFromName(firstName: string): 'Female' | 'Male' | 'Unknown' {
    const key = firstName.trim().toLowerCase();
    if (!key) return 'Unknown';
    if (FEMALE_NAMES.has(key)) return 'Female';
    if (MALE_NAMES.has(key)) return 'Male';
    return 'Unknown';
  }
}
