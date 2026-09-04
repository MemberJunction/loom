import { IdentityService, AvatarGenerator, LogoGenerator, type RngStream } from '@memberjunction/loom-engine';
import type { DomainConfig } from '@memberjunction/loom-contracts';

export interface GenerateEntityRecordOptions {
  domain: DomainConfig;
  entity: string;
  i: number;
  parentPool: Record<string, Record<string, unknown>[]>;
  rng: RngStream;
  identityService: IdentityService;
}

/**
 * Generates a single strongly-typed record for an entity.
 * - Populates only declared fields in domain.entities[entity].fields
 * - Throws if required foreign key parent records are missing
 * - Mints deterministic primary key UUIDs from declared business keys
 */
export function generateEntityRecord(options: GenerateEntityRecordOptions): Record<string, unknown> {
  const { domain, entity, i, parentPool, rng, identityService } = options;
  const entityCfg = domain.entities[entity];
  if (!entityCfg) {
    throw new Error(`generateEntityRecord: entity '${entity}' not found in domain`);
  }

  const row: Record<string, unknown> = {};

  // 1. Populate all declared non-PK fields first
  const fkList = Object.values(entityCfg.foreignKeys ?? {});

  for (const [fieldName, fieldCfg] of Object.entries(entityCfg.fields)) {
    if (fieldCfg.isPrimaryKey || fieldName === 'ID' || fieldName === 'id') continue;

    // Foreign key resolution: match fieldName against declared foreignKeys
    const fkIdx = fkList.findIndex((fk) => fk.fieldName === fieldName);
    if (fkIdx >= 0) {
      const fk = fkList[fkIdx]!;
      if (fk.lookupPattern) {
        let pattern = fk.lookupPattern;
        const targetRows = parentPool[fk.targetEntity];
        const parentIndex =
          targetRows && targetRows.length > 0
            ? (fkIdx === 0
                ? (i - 1) % targetRows.length
                : Math.floor((i - 1) / Math.pow(targetRows.length, fkIdx)) % targetRows.length)
            : undefined;
        const parent = parentIndex !== undefined && targetRows ? targetRows[parentIndex] : undefined;

        if (pattern.includes('${')) {
          pattern = pattern.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
            const key = expr.trim();
            if (key.startsWith('parent.')) {
              const field = key.slice(7);
              if (!parent) {
                throw new Error(
                  `lookupPattern template variable '\${${key}}' cannot be resolved: no parent record available for ${entity}.${fieldName} -> ${fk.targetEntity}`
                );
              }
              const val = parent[field];
              if (val === undefined || val === null || val === '') {
                throw new Error(
                  `lookupPattern template variable '\${${key}}' cannot be resolved: field '${field}' not found on parent entity '${fk.targetEntity}'`
                );
              }
              return String(val);
            }
            if (key.startsWith('row.')) {
              const field = key.slice(4);
              const val = row[field];
              if (val === undefined || val === null || val === '') {
                throw new Error(
                  `lookupPattern template variable '\${${key}}' cannot be resolved: field '${field}' not found on row for entity '${entity}'`
                );
              }
              return String(val);
            }
            if (parent && parent[key] !== undefined && parent[key] !== null && parent[key] !== '') {
              return String(parent[key]);
            }
            if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
              return String(row[key]);
            }
            throw new Error(
              `lookupPattern template variable '\${${key}}' cannot be resolved for ${entity}.${fieldName}`
            );
          });
        }
        row[fieldName] = pattern;
        continue;
      }
      const targetRows = parentPool[fk.targetEntity];
      if (!targetRows || targetRows.length === 0) {
        if (fieldCfg.defaultValue !== undefined) {
          row[fieldName] = fieldCfg.defaultValue;
          continue;
        }
        throw new Error(
          `No parent records available for foreign key ${entity}.${fieldName} -> ${fk.targetEntity}`
        );
      }
      // Generic multi-FK indexing: spread composite FK parents without hardcoded entity names
      const parentIndex =
        fkIdx === 0
          ? (i - 1) % targetRows.length
          : Math.floor((i - 1) / Math.pow(targetRows.length, fkIdx)) % targetRows.length;
      const parent = targetRows[parentIndex];
      if (!parent) {
        throw new Error(`Parent record at index ${parentIndex} not found in ${fk.targetEntity}`);
      }
      const parentId = parent[fk.targetField] ?? parent['ID'] ?? parent['id'];
      if (!parentId) {
        throw new Error(`Parent record in ${fk.targetEntity} missing primary key ID`);
      }
      row[fieldName] = parentId;
      continue;
    }

    if (fieldCfg.avatar || fieldName === 'PhotoURL' || fieldName === 'AvatarURL') {
      const avatarCfg = fieldCfg.avatar ?? {
        style: 'adventurer',
        format: 'url',
        genderField: 'Gender',
        seedField: 'Email',
      };
      const genderVal = row[avatarCfg.genderField ?? 'Gender'] ?? row['Gender'];
      const seedVal =
        row[avatarCfg.seedField ?? 'Email'] ??
        row['Email'] ??
        row['ID'] ??
        `${entity}-${i}`;
      row[fieldName] = AvatarGenerator.Generate({
        seed: String(seedVal),
        gender: genderVal !== undefined && genderVal !== null ? String(genderVal) : undefined,
        style: avatarCfg.style,
        format: avatarCfg.format,
        backgroundColor: avatarCfg.backgroundColor,
      });
    } else if (fieldCfg.logo || fieldName === 'LogoURL') {
      const logoCfg = fieldCfg.logo ?? {
        format: 'base64',
        nameField: 'Name',
        seedField: 'Name',
        shape: 'auto',
      };
      const nameVal = row[logoCfg.nameField ?? 'Name'] ?? row['Name'] ?? entity;
      const seedVal = row[logoCfg.seedField ?? 'Name'] ?? row['ID'] ?? `${entity}-${i}`;
      row[fieldName] = LogoGenerator.Generate({
        name: String(nameVal),
        seed: String(seedVal),
        format: logoCfg.format,
        shape: logoCfg.shape,
      });
    } else if (fieldCfg.values && fieldCfg.values.length > 0) {
      row[fieldName] = fieldCfg.values[(i - 1) % fieldCfg.values.length];
    } else if (fieldName === 'Name') {
      row[fieldName] = `${entity} Corp ${i}`;
    } else if (fieldName === 'FirstName') {
      row[fieldName] = `MemberFirst${i}`;
    } else if (fieldName === 'LastName') {
      row[fieldName] = `MemberLast${i}`;
    } else if (fieldName === 'Email') {
      row[fieldName] = `user${i}@enterprise${i}.com`;
    } else if (fieldName === 'SKU') {
      row[fieldName] = `SKU-${1000 + i}`;
    } else if (fieldName === 'OrderNumber') {
      row[fieldName] = `ORD-${20260000 + i}`;
    } else if (fieldName === 'Industry') {
      row[fieldName] = 'Technology';
    } else if (fieldName === 'Category') {
      row[fieldName] = i % 2 === 0 ? 'Hardware' : 'Software';
    } else if (fieldName === 'Title') {
      row[fieldName] = `Record ${fieldName} ${i}`;
    } else if (fieldName === 'PaymentMethod') {
      row[fieldName] = 'CreditCard';
    } else if (fieldName === 'Status') {
      row[fieldName] = 'Active';
    } else if (fieldName === 'AutoRenew') {
      row[fieldName] = i % 10 !== 4 && i % 10 !== 8 && i % 10 !== 0;
    } else if (fieldName === 'IsActive') {
      row[fieldName] = true;
    } else if (fieldName === 'Quantity') {
      row[fieldName] = rng.int(1, 4);
    } else if (
      fieldName.includes('Fee') ||
      fieldName.includes('Price') ||
      fieldName.includes('Amount')
    ) {
      row[fieldName] = 100 + (i % 50) * 10;
    } else if (fieldName === 'Employees') {
      row[fieldName] = 50 + (i % 100);
    } else if (fieldName === 'AnnualRevenue') {
      row[fieldName] = 1000000 + (i % 20) * 50000;
    } else if (fieldCfg.type === 'number') {
      row[fieldName] = i * 10;
    } else if (fieldCfg.type === 'boolean') {
      row[fieldName] = true;
    } else if (fieldCfg.type === 'date') {
      const year = 2026;
      const month = String(1 + (i % 12)).padStart(2, '0');
      const day = String(1 + (i % 28)).padStart(2, '0');
      if (fieldName === 'EndDate' && row['StartDate']) {
        const startStr = String(row['StartDate']).slice(0, 10);
        const startDay = parseInt(startStr.slice(8, 10), 10) || 1;
        const endDay = Math.min(28, startDay + 5);
        row[fieldName] = `${startStr.slice(0, 8)}${String(endDay).padStart(2, '0')}`;
      } else {
        row[fieldName] = `${year}-${month}-${day}`;
      }
    } else {
      row[fieldName] = `${entity}_${fieldName}_${i}`;
    }
  }

  // 2. Mint primary key ID using declared business key
  const domainName = domain.name;
  const businessKeys = (entityCfg.businessKey ?? []).filter(
    (k) => k !== 'ID' && k !== 'id'
  );
  if (businessKeys.length > 0) {
    const keyParts = businessKeys.map((keyField) => {
      const val = row[keyField];
      if (val === undefined || val === null) {
        throw new Error(
          `Business key field '${keyField}' missing on entity '${entity}' row`
        );
      }
      return String(val);
    });
    row['ID'] = identityService.MintId(domainName, entity, keyParts);
  } else {
    row['ID'] = identityService.MintId(domainName, entity, [`${entity}-${i}`]);
  }

  return row;
}
