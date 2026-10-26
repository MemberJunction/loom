import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DomainConfig } from '@memberjunction/loom-contracts';
import { appendMetadata, readEntityMetadata, extractComposedRecords, Accumulator } from '../src/index.js';

const domain: DomainConfig = {
  name: 'append-test',
  namespace: '00000000-0000-0000-0000-0000000000a1',
  packs: { core: { name: 'core', dependsOn: [] } },
  entities: {
    Order: {
      name: 'Order',
      entityName: 'Orders',
      targetTable: 'Order',
      schema: 'sales',
      pack: 'core',
      outputDirectory: 'orders',
      businessKey: ['ID'],
      fields: {
        ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
        OrderNumber: { name: 'OrderNumber', type: 'string' },
        Status: { name: 'Status', type: 'string' },
      },
      foreignKeys: {},
      composition: { collections: { Lines: { entity: 'OrderLine', foreignKey: 'OrderID', mode: 'upsert' } } },
      isImmutable: false,
    },
    OrderLine: {
      name: 'OrderLine',
      entityName: 'Order Lines',
      targetTable: 'OrderLine',
      schema: 'sales',
      pack: 'core',
      businessKey: ['ID'],
      fields: {
        ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
        OrderID: { name: 'OrderID', type: 'uuid' },
        Sequence: { name: 'Sequence', type: 'number' },
      },
      foreignKeys: { OrderID: { fieldName: 'OrderID', targetEntity: 'Order', targetField: 'ID' } },
      isImmutable: false,
    },
    EventOrderLine: {
      name: 'EventOrderLine',
      entityName: 'Event Order Lines',
      targetTable: 'EventOrderLine',
      schema: 'sales',
      pack: 'core',
      businessKey: ['ID'],
      composition: { isA: { parentEntity: 'OrderLine', when: 'ProductType.OrderLineExtensionEntity' } },
      fields: {
        ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
        AttendanceStatus: { name: 'AttendanceStatus', type: 'string' },
      },
      foreignKeys: {},
      isImmutable: false,
    },
    Sequence: {
      name: 'Sequence',
      entityName: 'Number Sequences',
      targetTable: 'NumberSequence',
      schema: 'sales',
      pack: 'core',
      outputDirectory: 'sequences',
      businessKey: ['ScopeCode'],
      fields: {
        ScopeCode: { name: 'ScopeCode', type: 'string', isPrimaryKey: true },
        NextSequenceNumber: { name: 'NextSequenceNumber', type: 'number' },
      },
      foreignKeys: {},
      isImmutable: false,
    },
    Note: {
      name: 'Note',
      entityName: 'Notes',
      targetTable: 'Note',
      schema: 'sales',
      pack: 'core',
      outputDirectory: 'notes',
      businessKey: ['ID'],
      fields: {
        ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
        OrderID: { name: 'OrderID', type: 'uuid' },
      },
      foreignKeys: { OrderID: { fieldName: 'OrderID', targetEntity: 'Order', targetField: 'ID' } },
      isImmutable: false,
    },
  },
} as unknown as DomainConfig;

const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';
const L1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const L2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

/** A committed tree written the way MetadataSync leaves it: sync blocks, no trailing newline, children carrying their FK. */
async function writeCommittedTree(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'orders'), { recursive: true });
  await fs.mkdir(path.join(dir, 'sequences'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.mj-sync.json'),
    JSON.stringify({ directoryOrder: ['orders', 'frozen-catalog', 'sequences'], push: { autoCreateMissingRecords: true } }, null, 2)
  );
  await fs.writeFile(
    path.join(dir, 'orders', '.mj-sync.json'),
    JSON.stringify({ entity: 'Orders', filePattern: '**/.*.json' }, null, 2)
  );
  const order = (id: string, num: string, lines: unknown[]) => ({
    fields: { OrderNumber: num, Status: 'Open' },
    primaryKey: { ID: id },
    sync: { lastModified: '2026-09-17T02:25:13.673Z', checksum: 'abc' },
    collections: { Lines: lines },
  });
  // Lines ordered by Sequence (not by ID), each carrying OrderID, one with an IsA extension
  const lines = [
    { fields: { OrderID: O1, Sequence: 1 }, primaryKey: { ID: L2 } },
    {
      fields: { OrderID: O1, Sequence: 2 },
      primaryKey: { ID: L1 },
      extension: { entity: 'Event Order Lines', fields: { AttendanceStatus: 'Registered' } },
    },
  ];
  await fs.writeFile(path.join(dir, 'orders', '.orders.part-01.json'), JSON.stringify([order(O1, 'ORD-1', lines)], null, 2));
  await fs.writeFile(path.join(dir, 'orders', '.orders.part-02.json'), JSON.stringify([order(O2, 'ORD-2', [])], null, 2));
  await fs.writeFile(path.join(dir, 'sequences', '.mj-sync.json'), JSON.stringify({ entity: 'Number Sequences' }, null, 2));
  await fs.writeFile(
    path.join(dir, 'sequences', '.sequences.json'),
    JSON.stringify([{ fields: { NextSequenceNumber: 134 }, primaryKey: { ScopeCode: 'MC' } }], null, 2)
  );
}

async function readTree(dir: string) {
  const prior: Record<string, Record<string, unknown>[]> = {};
  for (const [name, cfg] of Object.entries(domain.entities)) {
    const d = path.join(dir, cfg.outputDirectory ?? name);
    prior[name] = cfg.outputDirectory && (await exists(d)) ? (await readEntityMetadata(d, cfg.entityName)).records : [];
  }
  return extractComposedRecords(domain, prior);
}

async function exists(p: string) {
  return fs.access(p).then(() => true, () => false);
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[path.relative(dir, p)] = await fs.readFile(p, 'utf8');
    }
  };
  await walk(dir);
  return out;
}

const clone = (recs: Record<string, Record<string, unknown>[]>) =>
  Object.fromEntries(Object.entries(recs).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));

describe('appendMetadata', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-append-'));
    await writeCommittedTree(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('leaves every committed file byte-for-byte unchanged when nothing is new', async () => {
    const before = await snapshot(dir);
    const prior = await readTree(dir);
    const result = await appendMetadata({ outputDir: dir, priorDir: dir, domain, priorRecords: prior, currentRecords: clone(prior) });
    expect(result.writtenFiles).toEqual([]);
    expect(await snapshot(dir)).toEqual(before);
  });

  it('appends new records without touching prior records, and fills the last part before starting another', async () => {
    const prior = await readTree(dir);
    const current = clone(prior);
    const o3 = '33333333-3333-4333-8333-333333333333';
    const o4 = '44444444-4444-4444-8444-444444444444';
    current.Order!.push({ ID: o3, OrderNumber: 'ORD-3', Status: 'Open' }, { ID: o4, OrderNumber: 'ORD-4', Status: 'Open' });
    current.OrderLine!.push({ ID: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', OrderID: o3, Sequence: 1 });

    const before = await snapshot(dir);
    const result = await appendMetadata({ outputDir: dir, priorDir: dir, domain, priorRecords: prior, currentRecords: current, maxPartSize: 2 });
    const after = await snapshot(dir);

    expect(result.appendedCounts).toEqual({ Order: 2, OrderLine: 1 });
    // part-01 untouched; part-02 gets one more record (now full at 2); part-03 holds the overflow
    expect(after['orders/.orders.part-01.json']).toBe(before['orders/.orders.part-01.json']);
    const part2 = JSON.parse(after['orders/.orders.part-02.json']!);
    expect(part2).toHaveLength(2);
    expect(part2[0]).toEqual(JSON.parse(before['orders/.orders.part-02.json']!)[0]);
    expect(part2[1].primaryKey.ID).toBe(o3);
    // The new order's line keeps the directory's convention of carrying OrderID
    expect(part2[1].collections.Lines[0].fields.OrderID).toBe(o3);
    expect(after['orders/.orders.part-02.json']!.endsWith('\n')).toBe(false);
    expect(JSON.parse(after['orders/.orders.part-03.json']!)[0].primaryKey.ID).toBe(o4);
    // Directory config and root order preserved (including directories the domain does not know)
    expect(after['orders/.mj-sync.json']).toBe(before['orders/.mj-sync.json']);
    expect(after['.mj-sync.json']).toBe(before['.mj-sync.json']);
  });

  it('places new children under prior parents and updates changed prior fields in place', async () => {
    const prior = await readTree(dir);
    const current = clone(prior);
    const newLine = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
    current.OrderLine!.push({ ID: newLine, OrderID: O2, Sequence: 1 });
    current.Order!.find((o) => o['ID'] === O1)!['Status'] = 'Closed';
    current.EventOrderLine!.find((e) => e['ID'] === L1)!['AttendanceStatus'] = 'Attended';

    const result = await appendMetadata({ outputDir: dir, priorDir: dir, domain, priorRecords: prior, currentRecords: current });
    expect(result.updatedCounts).toEqual({ Order: 1, EventOrderLine: 1 });

    const part1 = JSON.parse(await fs.readFile(path.join(dir, 'orders', '.orders.part-01.json'), 'utf8'));
    expect(part1[0].fields.Status).toBe('Closed');
    expect(part1[0].sync).toEqual({ lastModified: '2026-09-17T02:25:13.673Z', checksum: 'abc' });
    expect(part1[0].collections.Lines.map((l: { primaryKey: { ID: string } }) => l.primaryKey.ID)).toEqual([L2, L1]);
    expect(part1[0].collections.Lines[1].extension.fields.AttendanceStatus).toBe('Attended');

    const part2 = JSON.parse(await fs.readFile(path.join(dir, 'orders', '.orders.part-02.json'), 'utf8'));
    expect(part2[0].collections.Lines).toEqual([{ primaryKey: { ID: newLine }, fields: { OrderID: O2, Sequence: 1 } }]);
  });

  it('handles entities keyed by a natural key, and adds a new directory after its parents in the root order', async () => {
    const prior = await readTree(dir);
    const current = clone(prior);
    current.Sequence!.find((s) => s['ScopeCode'] === 'MC')!['NextSequenceNumber'] = 140;
    current.Note!.push({ ID: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', OrderID: O1 });

    await appendMetadata({ outputDir: dir, priorDir: dir, domain, priorRecords: prior, currentRecords: current });

    const seq = JSON.parse(await fs.readFile(path.join(dir, 'sequences', '.sequences.json'), 'utf8'));
    expect(seq).toEqual([{ fields: { NextSequenceNumber: 140 }, primaryKey: { ScopeCode: 'MC' } }]);
    const root = JSON.parse(await fs.readFile(path.join(dir, '.mj-sync.json'), 'utf8'));
    expect(root.directoryOrder).toEqual(['orders', 'notes', 'frozen-catalog', 'sequences']);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'notes', '.notes.json'), 'utf8'))).toHaveLength(1);
  });

  it('copies the prior tree when writing to a separate output directory', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-append-out-'));
    try {
      const prior = await readTree(dir);
      await appendMetadata({ outputDir: out, priorDir: dir, domain, priorRecords: prior, currentRecords: clone(prior) });
      expect(await snapshot(out)).toEqual(await snapshot(dir));
    } finally {
      await fs.rm(out, { recursive: true, force: true });
    }
  });

  it('rejects a new child whose parent exists nowhere', async () => {
    const prior = await readTree(dir);
    const current = clone(prior);
    current.OrderLine!.push({ ID: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', OrderID: '99999999-9999-4999-8999-999999999999', Sequence: 1 });
    await expect(
      appendMetadata({ outputDir: dir, priorDir: dir, domain, priorRecords: prior, currentRecords: current })
    ).rejects.toThrow(/has no parent Order/);
  });
});

describe('Accumulator keys', () => {
  it('lets an IsA child share its parent ID, and keys natural-key entities by their declared key', async () => {
    const prior = {
      OrderLine: [{ ID: L1, OrderID: O1 }],
      EventOrderLine: [{ ID: L1, AttendanceStatus: 'Registered' }],
      Sequence: [{ ScopeCode: 'MC', NextSequenceNumber: 1 }],
    };
    const current = {
      ...prior,
      Sequence: [...prior.Sequence, { ScopeCode: 'EV', NextSequenceNumber: 1 }],
    };
    const diff = new Accumulator().ComputeDelta(domain, 1, '2026-10-31', prior, current);
    expect(diff.newRecordCounts).toMatchObject({ OrderLine: 0, EventOrderLine: 0, Sequence: 1 });
  });

  it('still rejects one ID reused across unrelated entities', () => {
    const prior = { Order: [{ ID: O1 }] };
    const current = { Order: [{ ID: O1 }], Note: [{ ID: O1 }] };
    expect(() => new Accumulator().ComputeDelta(domain, 1, '2026-10-31', prior, current)).toThrow(/cannot be reassigned/);
  });
});
