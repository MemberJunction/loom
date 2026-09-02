import { v5 as uuidv5 } from 'uuid';

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
}
