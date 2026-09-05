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

const FEMALE_NAMES = new Set([
  'elena', 'maria', 'priya', 'sophia', 'emma', 'olivia', 'ava', 'mia', 'amelia',
  'charlotte', 'harper', 'evelyn', 'abigail', 'emily', 'elizabeth', 'sofia',
  'madison', 'avery', 'ella', 'scarlett', 'grace', 'chloe', 'camila', 'penelope',
  'layla', 'riley', 'zoey', 'nora', 'lily', 'eleanor', 'hannah', 'lillian',
  'addison', 'aubrey', 'ellie', 'stella', 'natalie', 'zoe', 'leah', 'hazel',
  'violet', 'aurora', 'savannah', 'audrey', 'brooklyn', 'bella', 'claire',
  'skylar', 'lucy', 'paisley', 'everly', 'anna', 'caroline', 'nova', 'genesis',
  'aaliyah', 'kennedy', 'kinsley', 'allison', 'maya', 'sarah', 'madelyn', 'adeline',
  'alexa', 'ariana', 'elena', 'gabriella', 'naomi', 'alice', 'sadie', 'hailey',
  'eva', 'emilia', 'autumn', 'quinn', 'nevaeh', 'piper', 'ruby', 'serenity',
  'willow', 'everleigh', 'clover', 'isla',
]);

const MALE_NAMES = new Set([
  'marcus', 'james', 'liam', 'noah', 'oliver', 'elijah', 'william', 'henry',
  'lucas', 'benjamin', 'theodore', 'jack', 'levi', 'alexander', 'jackson',
  'mateo', 'daniel', 'michael', 'mason', 'sebastian', 'ethan', 'logan', 'owen',
  'samuel', 'jacob', 'asher', 'aiden', 'john', 'joseph', 'wyatt', 'david',
  'leo', 'luke', 'julian', 'hudson', 'grayson', 'matthew', 'ezra', 'gabriel',
  'carter', 'isaac', 'jayden', 'luca', 'anthony', 'dylan', 'lincoln', 'thomas',
  'maverick', 'elias', 'josiah', 'charles', 'caleb', 'christopher', 'ezekiel',
  'miles', 'jaxon', 'isaiah', 'andrew', 'joshua', 'nathan', 'nolan', 'adrian',
  'cameron', 'santiago', 'eli', 'aaron', 'ryan', 'angel', 'cooper', 'waylon',
  'roman', 'easton', 'miles', 'robert', 'jameson', 'ian', 'kai', 'landon',
]);
