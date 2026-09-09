import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DomainConfigSchema,
  createDomainConfigFromMJEntities,
  validateDomainAgainstMJMetadata,
  type DomainConfig,
} from '@memberjunction/loom-contracts';
import {
  emitMetadata,
  readEntityMetadata,
  extractComposedRecords,
  Validator,
} from '../src/index.js';
import { EntityInfo } from '@memberjunction/core';

describe('Loom Composition Axes (§7)', () => {
  const sampleDomain: DomainConfig = {
    name: 'test-composition-domain',
    namespace: '00000000-0000-0000-0000-000000000001',
    packs: {
      core: { name: 'core', dependsOn: [] },
    },
    entities: {
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
          ProductID: { name: 'ProductID', type: 'uuid' },
          Quantity: { name: 'Quantity', type: 'number' },
        },
        foreignKeys: {},
        isImmutable: false,
      },
      EventOrderLine: {
        name: 'EventOrderLine',
        entityName: 'Event Order Lines',
        targetTable: 'EventOrderLine',
        schema: 'sales',
        pack: 'core',
        businessKey: ['ID'],
        composition: {
          isA: {
            parentEntity: 'OrderLine',
            when: 'ProductType.OrderLineExtensionEntity',
          },
        },
        fields: {
          ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
          PersonID: { name: 'PersonID', type: 'uuid' },
          BadgeName: { name: 'BadgeName', type: 'string' },
        },
        foreignKeys: {},
        isImmutable: false,
      },
      CommitteeMeeting: {
        name: 'CommitteeMeeting',
        entityName: 'Committee Meetings',
        targetTable: 'CommitteeMeeting',
        schema: 'governance',
        pack: 'core',
        businessKey: ['ID'],
        composition: {
          collections: {
            AgendaItems: {
              entity: 'CommitteeAgendaItem',
              foreignKey: 'MeetingID',
              mode: 'upsert',
            },
          },
          embeds: {
            LocationAddressID: {
              entity: 'MeetingAddress',
              foreignKey: 'ID',
            },
          },
        },
        fields: {
          ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
          Title: { name: 'Title', type: 'string' },
          LocationAddressID: { name: 'LocationAddressID', type: 'uuid', nullable: true },
        },
        foreignKeys: {},
        isImmutable: false,
      },
      CommitteeAgendaItem: {
        name: 'CommitteeAgendaItem',
        entityName: 'Committee Agenda Items',
        targetTable: 'CommitteeAgendaItem',
        schema: 'governance',
        pack: 'core',
        businessKey: ['ID'],
        fields: {
          ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
          MeetingID: { name: 'MeetingID', type: 'uuid' },
          Topic: { name: 'Topic', type: 'string' },
          Sequence: { name: 'Sequence', type: 'number' },
        },
        foreignKeys: {},
        isImmutable: false,
      },
      MeetingAddress: {
        name: 'MeetingAddress',
        entityName: 'Meeting Addresses',
        targetTable: 'MeetingAddress',
        schema: 'governance',
        pack: 'core',
        businessKey: ['ID'],
        fields: {
          ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
          Street: { name: 'Street', type: 'string' },
          City: { name: 'City', type: 'string' },
        },
        foreignKeys: {},
        isImmutable: false,
      },
    },
  };

  describe('1. DomainConfigSchema Composition Parsing', () => {
    it('successfully parses entities with isA, collections, and embeds composition blocks', () => {
      const parsed = DomainConfigSchema.parse(sampleDomain);
      expect(parsed.entities['EventOrderLine']?.composition?.isA?.parentEntity).toBe('OrderLine');
      expect(parsed.entities['EventOrderLine']?.composition?.isA?.when).toBe('ProductType.OrderLineExtensionEntity');
      expect(parsed.entities['CommitteeMeeting']?.composition?.collections?.['AgendaItems']?.entity).toBe('CommitteeAgendaItem');
      expect(parsed.entities['CommitteeMeeting']?.composition?.collections?.['AgendaItems']?.foreignKey).toBe('MeetingID');
      expect(parsed.entities['CommitteeMeeting']?.composition?.embeds?.['LocationAddressID']?.entity).toBe('MeetingAddress');
    });
  });

  describe('2. createDomainConfigFromMJEntities & SubtypeSelector metadata extraction', () => {
    it('reads ParentID, SubtypeSelector Path, RelatedRecordCollection, and EmbeddedRecord', () => {
      const parentEntity: EntityInfo = {
        ID: 'parent-line-uuid',
        Name: 'Order Lines',
        BaseTable: 'OrderLine',
        SchemaName: 'sales',
        SubtypeSelector: JSON.stringify({ Path: 'ProductID.ProductTypeID.OrderLineExtensionEntity' }),
        Fields: [
          { Name: 'ID', Type: 'uniqueidentifier', IsPrimaryKey: true, AllowsNull: false },
          { Name: 'OrderNumber', Type: 'nvarchar', IsPrimaryKey: false, AllowsNull: false },
        ],
        PrimaryKeys: [{ Name: 'ID' }],
        RelatedEntities: [],
      } as unknown as EntityInfo;

      const childEntity: EntityInfo = {
        ID: 'child-line-uuid',
        Name: 'Event Order Lines',
        BaseTable: 'EventOrderLine',
        SchemaName: 'sales',
        ParentID: 'parent-line-uuid',
        Fields: [
          { Name: 'ID', Type: 'uniqueidentifier', IsPrimaryKey: true, AllowsNull: false },
          { Name: 'PersonID', Type: 'uniqueidentifier', IsPrimaryKey: false, AllowsNull: true },
          { Name: 'BadgeName', Type: 'nvarchar', IsPrimaryKey: false, AllowsNull: true },
        ],
        PrimaryKeys: [{ Name: 'ID' }],
        RelatedEntities: [],
      } as unknown as EntityInfo;

      const meetingEntity: EntityInfo = {
        ID: 'meeting-uuid',
        Name: 'Committee Meetings',
        BaseTable: 'CommitteeMeeting',
        SchemaName: 'governance',
        Fields: [
          { Name: 'ID', Type: 'uniqueidentifier', IsPrimaryKey: true, AllowsNull: false },
          { Name: 'Title', Type: 'nvarchar', IsPrimaryKey: false, AllowsNull: false },
          {
            Name: 'LocationAddressID',
            Type: 'uniqueidentifier',
            IsPrimaryKey: false,
            AllowsNull: true,
            RelatedEntity: 'Meeting Addresses',
            RelatedEntityFieldName: 'ID',
            EmbeddedRecord: JSON.stringify({ OnClear: 'SetNull' }),
          },
        ],
        PrimaryKeys: [{ Name: 'ID' }],
        RelatedEntities: [
          {
            RelatedEntity: 'Committee Agenda Items',
            RelatedEntityJoinField: 'MeetingID',
            DisplayName: 'AgendaItems',
            RelatedRecordCollection: JSON.stringify({ Name: 'AgendaItems', Mode: 'upsert' }),
          },
        ],
      } as unknown as EntityInfo;

      const domain = createDomainConfigFromMJEntities(
        [parentEntity, childEntity, meetingEntity],
        '00000000-0000-0000-0000-000000000002',
        'generated-domain',
        {
          businessKeyMap: {
            'Order Lines': ['ID'],
            'Event Order Lines': ['ID'],
            'Committee Meetings': ['ID'],
          },
        }
      );

      // Child has isA pointing to Order Lines with when condition from SubtypeSelector
      const childConfig = domain.entities['Event Order Lines'];
      expect(childConfig?.composition?.isA?.parentEntity).toBe('Order Lines');
      expect(childConfig?.composition?.isA?.when).toBe('ProductID.ProductTypeID.OrderLineExtensionEntity');

      // Meeting has collections and embeds
      const meetingConfig = domain.entities['Committee Meetings'];
      expect(meetingConfig?.composition?.collections?.['AgendaItems']?.entity).toBe('Committee Agenda Items');
      expect(meetingConfig?.composition?.collections?.['AgendaItems']?.foreignKey).toBe('MeetingID');
      expect(meetingConfig?.composition?.embeds?.['LocationAddressID']?.entity).toBe('Meeting Addresses');
    });

    it('warns explicitly when subtype rule lives only in runtime resolver without metadata selector', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const parentEntity: EntityInfo = {
        ID: 'p-1',
        Name: 'Products',
        BaseTable: 'Product',
        SchemaName: 'catalog',
        SubtypeSelector: null, // No selector in metadata!
        Fields: [{ Name: 'ID', Type: 'uniqueidentifier', IsPrimaryKey: true }],
      } as unknown as EntityInfo;

      const childEntity: EntityInfo = {
        ID: 'c-1',
        Name: 'Event Products',
        BaseTable: 'EventProduct',
        SchemaName: 'catalog',
        ParentID: 'p-1',
        Fields: [{ Name: 'ID', Type: 'uniqueidentifier', IsPrimaryKey: true }],
      } as unknown as EntityInfo;

      createDomainConfigFromMJEntities(
        [parentEntity, childEntity],
        '00000000-0000-0000-0000-000000000003',
        'runtime-resolver-domain',
        { businessKeyMap: { Products: ['ID'], 'Event Products': ['ID'] } }
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('subtype rule for Event Products is runtime-only; cannot validate')
      );
      warnSpy.mockRestore();
    });

    it('fails at load when domain.json declares isA but MJ metadata has no ParentID', () => {
      const invalidDomain: DomainConfig = {
        name: 'stale-domain',
        namespace: '00000000-0000-0000-0000-000000000004',
        packs: {},
        entities: {
          OrphanChild: {
            name: 'OrphanChild',
            entityName: 'Orphan Child',
            targetTable: 'OrphanChild',
            schema: 'dbo',
            pack: 'common',
            businessKey: ['ID'],
            composition: {
              isA: {
                parentEntity: 'ParentEntity',
              },
            },
            fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true } },
            foreignKeys: {},
            isImmutable: false,
          },
        },
      };

      const mjEntities: EntityInfo[] = [
        {
          ID: 'orphan-uuid',
          Name: 'Orphan Child',
          ParentID: null, // Metadata does NOT have ParentID!
        } as unknown as EntityInfo,
      ];

      expect(() => {
        validateDomainAgainstMJMetadata(invalidDomain, mjEntities);
      }).toThrowError(/Domain entity 'OrphanChild' declares isA parent 'ParentEntity', but MJ metadata has no ParentID/);
    });

    it('warns when MJ metadata declares ParentID for an entity present in domain.json but domain.json has no composition.isA', () => {
      const domainWithoutIsA: DomainConfig = {
        name: 'missing-isa-domain',
        namespace: '00000000-0000-0000-0000-000000000005',
        packs: {},
        entities: {
          SubtypeChild: {
            name: 'SubtypeChild',
            entityName: 'Subtype Child',
            targetTable: 'SubtypeChild',
            schema: 'dbo',
            pack: 'common',
            businessKey: ['ID'],
            fields: { ID: { name: 'ID', type: 'uuid', isPrimaryKey: true } },
            foreignKeys: {},
            isImmutable: false,
          },
        },
      };

      const mockChild = new EntityInfo();
      mockChild.ID = 'subtype-uuid';
      mockChild.Name = 'Subtype Child';
      mockChild.ParentID = 'parent-uuid';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        validateDomainAgainstMJMetadata(domainWithoutIsA, [mockChild]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            "MJ metadata declares ParentID for 'Subtype Child' but domain.json declares no composition.isA — Gate 11 cannot validate this subtype."
          )
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('3. emitMetadata, readEntityMetadata & extractComposedRecords', () => {
    let tmpDir: string;

    it('emits extension, collections, and embeds into parent records, omitting child directories', async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-comp-test-'));

      const orderLineId = '11111111-1111-1111-1111-111111111111';
      const meetingId = '22222222-2222-2222-2222-222222222222';
      const agendaId = '33333333-3333-3333-3333-333333333333';
      const addressId = '44444444-4444-4444-4444-444444444444';

      const data: Record<string, readonly Record<string, unknown>[]> = {
        OrderLine: [
          {
            ID: orderLineId,
            OrderID: 'ord-100',
            ProductID: 'prod-event',
            Quantity: 2,
          },
        ],
        EventOrderLine: [
          {
            ID: orderLineId, // Matches parent PK
            PersonID: 'person-500',
            BadgeName: 'VIP Attendee',
          },
        ],
        CommitteeMeeting: [
          {
            ID: meetingId,
            Title: 'Q3 Board Meeting',
            LocationAddressID: addressId,
          },
        ],
        CommitteeAgendaItem: [
          {
            ID: agendaId,
            MeetingID: meetingId,
            Topic: 'Budget Review',
            Sequence: 1,
          },
        ],
        MeetingAddress: [
          {
            ID: addressId,
            Street: '100 Main St',
            City: 'Austin',
          },
        ],
      };

      const emittedFiles = await emitMetadata({
        outputDir: tmpDir,
        domain: sampleDomain,
        data,
      });

      expect(emittedFiles.length).toBeGreaterThan(0);

      // Verify root .mj-sync.json contains only parent directories, NOT composed children
      const rootSyncRaw = await fs.readFile(path.join(tmpDir, '.mj-sync.json'), 'utf8');
      const rootSync = JSON.parse(rootSyncRaw);
      expect(rootSync.directoryOrder).toContain('OrderLine');
      expect(rootSync.directoryOrder).toContain('CommitteeMeeting');
      expect(rootSync.directoryOrder).not.toContain('EventOrderLine');
      expect(rootSync.directoryOrder).not.toContain('CommitteeAgendaItem');
      expect(rootSync.directoryOrder).not.toContain('MeetingAddress');

      // Verify EventOrderLine directory was NOT created
      await expect(fs.access(path.join(tmpDir, 'EventOrderLine'))).rejects.toThrow();

      // Verify OrderLine has nested extension with leaf fields only
      const { records: orderLines } = await readEntityMetadata(path.join(tmpDir, 'OrderLine'), 'Order Lines');
      expect(orderLines).toHaveLength(1);
      const line = orderLines[0]!;
      expect(line.ID).toBe(orderLineId);
      expect(line.extension).toBeDefined();
      const ext = line.extension as { entity?: string; fields: Record<string, unknown> };
      expect(ext.fields.PersonID).toBe('person-500');
      expect(ext.fields.BadgeName).toBe('VIP Attendee');
      // Shared PK must NOT be duplicated in extension.fields
      expect(ext.fields.ID).toBeUndefined();

      // Verify CommitteeMeeting has collections and embeds
      const { records: meetings } = await readEntityMetadata(path.join(tmpDir, 'CommitteeMeeting'), 'Committee Meetings');
      expect(meetings).toHaveLength(1);
      const m = meetings[0]!;
      expect(m.ID).toBe(meetingId);
      expect(m.collections).toBeDefined();
      const cols = m.collections as Record<string, Array<{ primaryKey: Record<string, unknown>; fields: Record<string, unknown> }>>;
      expect(cols.AgendaItems).toHaveLength(1);
      expect(cols.AgendaItems[0]!.primaryKey.ID).toBe(agendaId);
      expect(cols.AgendaItems[0]!.fields.Topic).toBe('Budget Review');

      expect(m.embeds).toBeDefined();
      const embeds = m.embeds as Record<string, { primaryKey: Record<string, unknown>; fields: Record<string, unknown> }>;
      expect(embeds.LocationAddressID.primaryKey.ID).toBe(addressId);
      expect(embeds.LocationAddressID.fields.City).toBe('Austin');

      // Verify extractComposedRecords reconstitutes flat child records
      const reconstituted = extractComposedRecords(sampleDomain, {
        OrderLine: orderLines,
        CommitteeMeeting: meetings,
      });

      expect(reconstituted['EventOrderLine']).toHaveLength(1);
      expect(reconstituted['EventOrderLine']![0]!.ID).toBe(orderLineId);
      expect(reconstituted['EventOrderLine']![0]!.BadgeName).toBe('VIP Attendee');

      expect(reconstituted['CommitteeAgendaItem']).toHaveLength(1);
      expect(reconstituted['CommitteeAgendaItem']![0]!.ID).toBe(agendaId);
      expect(reconstituted['CommitteeAgendaItem']![0]!.MeetingID).toBe(meetingId);

      expect(reconstituted['MeetingAddress']).toHaveLength(1);
      expect(reconstituted['MeetingAddress']![0]!.ID).toBe(addressId);
      expect(reconstituted['MeetingAddress']![0]!.City).toBe('Austin');

      // Cleanup
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('recursively emits and reconstitutes multi-level nested collections', async () => {
      const nestedDomain: DomainConfig = {
        ...sampleDomain,
        entities: {
          ...sampleDomain.entities,
          CommitteeMotion: {
            name: 'CommitteeMotion',
            entityName: 'Committees: Motions',
            targetTable: 'Motion',
            schema: 'sample',
            pack: 'sample',
            outputDirectory: 'committee-motions',
            fields: {
              ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
              MeetingID: { name: 'MeetingID', type: 'uuid' },
              Name: { name: 'Name', type: 'string' },
            },
            foreignKeys: {
              MeetingID: { targetEntity: 'CommitteeMeeting', targetField: 'ID' },
            },
            composition: {
              collections: {
                Votes: { entity: 'CommitteeVote', foreignKey: 'MotionID', mode: 'upsert' },
              },
            },
          },
          CommitteeVote: {
            name: 'CommitteeVote',
            entityName: 'Committees: Votes',
            targetTable: 'Vote',
            schema: 'sample',
            pack: 'sample',
            outputDirectory: 'committee-votes',
            fields: {
              ID: { name: 'ID', type: 'uuid', isPrimaryKey: true },
              MotionID: { name: 'MotionID', type: 'uuid' },
              VoteValue: { name: 'VoteValue', type: 'string' },
            },
            foreignKeys: {
              MotionID: { targetEntity: 'CommitteeMotion', targetField: 'ID' },
            },
          },
          CommitteeMeeting: {
            ...sampleDomain.entities.CommitteeMeeting,
            composition: {
              collections: {
                Motions: { entity: 'CommitteeMotion', foreignKey: 'MeetingID', mode: 'upsert' },
              },
            },
          },
        },
      };

      const tmpDir = path.join(os.tmpdir(), `loom-test-nested-${Date.now()}`);
      const meetingId = 'meet-nested-1';
      const motionId = 'motion-nested-1';
      const voteId = 'vote-nested-1';

      const data: Record<string, readonly Record<string, unknown>[]> = {
        CommitteeMeeting: [{ ID: meetingId, Title: 'Board Meeting', LocationAddressID: null }],
        CommitteeMotion: [{ ID: motionId, MeetingID: meetingId, Name: 'Approve Budget' }],
        CommitteeVote: [{ ID: voteId, MotionID: motionId, VoteValue: 'Yes' }],
      };

      await emitMetadata({
        outputDir: tmpDir,
        domain: nestedDomain,
        data,
      });

      const { records: meetings } = await readEntityMetadata(path.join(tmpDir, 'CommitteeMeeting'), 'Committee Meetings');
      expect(meetings).toHaveLength(1);
      const m = meetings[0]!;
      const motions = m.collections?.Motions as Array<{ primaryKey: Record<string, unknown>; fields: Record<string, unknown>; collections?: Record<string, unknown[]> }>;
      expect(motions).toHaveLength(1);
      expect(motions[0]!.primaryKey.ID).toBe(motionId);
      expect(motions[0]!.fields.Name).toBe('Approve Budget');
      expect(motions[0]!.fields.MeetingID).toBeUndefined();

      const votes = motions[0]!.collections?.Votes as Array<{ primaryKey: Record<string, unknown>; fields: Record<string, unknown> }>;
      expect(votes).toHaveLength(1);
      expect(votes[0]!.primaryKey.ID).toBe(voteId);
      expect(votes[0]!.fields.VoteValue).toBe('Yes');
      expect(votes[0]!.fields.MotionID).toBeUndefined();

      // Cleanup
      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('4. Validator Composition Invariants Gates', () => {
    it('passes when composition invariants are satisfied', () => {
      const validator = new Validator();
      const data: Record<string, readonly Record<string, unknown>[]> = {
        OrderLine: [{ ID: 'pk-1', OrderID: 'ord-1', ProductID: 'prod-1', Quantity: 1 }],
        EventOrderLine: [{ ID: 'pk-1', PersonID: 'p-1', BadgeName: 'Speaker' }],
        CommitteeMeeting: [{ ID: 'meet-1', Title: 'Finance Committee', LocationAddressID: 'addr-1' }],
        CommitteeAgendaItem: [{ ID: 'agenda-1', MeetingID: 'meet-1', Topic: 'Audit Report', Sequence: 1 }],
        MeetingAddress: [{ ID: 'addr-1', Street: '500 Congress Ave', City: 'Austin' }],
      };

      const report = validator.Validate(sampleDomain, data);
      const isAGate = report.gates.find((g) => g.name.includes('Composition: IsA Invariants'));
      const colGate = report.gates.find((g) => g.name.includes('Composition: Collection Invariants'));
      const embedGate = report.gates.find((g) => g.name.includes('Composition: Embed Invariants'));

      expect(isAGate).toBeDefined();
      expect(isAGate?.passed).toBe(true);

      expect(colGate).toBeDefined();
      expect(colGate?.passed).toBe(true);

      expect(embedGate).toBeDefined();
      expect(embedGate?.passed).toBe(true);
    });

    it('fails when IsA child record has no matching parent record', () => {
      const validator = new Validator();
      const data: Record<string, readonly Record<string, unknown>[]> = {
        OrderLine: [{ ID: 'pk-1', OrderID: 'ord-1', ProductID: 'prod-1', Quantity: 1 }],
        EventOrderLine: [{ ID: 'pk-orphan', PersonID: 'p-1', BadgeName: 'Speaker' }], // Orphan ID
        CommitteeMeeting: [{ ID: 'meet-1', Title: 'Finance Committee', LocationAddressID: 'addr-1' }],
        CommitteeAgendaItem: [{ ID: 'agenda-1', MeetingID: 'meet-1', Topic: 'Audit Report', Sequence: 1 }],
        MeetingAddress: [{ ID: 'addr-1', Street: '500 Congress Ave', City: 'Austin' }],
      };

      const report = validator.Validate(sampleDomain, data);
      const isAGate = report.gates.find((g) => g.name.includes('Composition: IsA Invariants'));
      expect(isAGate?.passed).toBe(false);
      expect(isAGate?.message).toContain('1 EventOrderLine records have no matching parent in OrderLine');
    });

    it('fails when collection item points to non-existent parent', () => {
      const validator = new Validator();
      const data: Record<string, readonly Record<string, unknown>[]> = {
        OrderLine: [{ ID: 'pk-1', OrderID: 'ord-1', ProductID: 'prod-1', Quantity: 1 }],
        EventOrderLine: [{ ID: 'pk-1', PersonID: 'p-1', BadgeName: 'Speaker' }],
        CommitteeMeeting: [{ ID: 'meet-1', Title: 'Finance Committee', LocationAddressID: 'addr-1' }],
        CommitteeAgendaItem: [{ ID: 'agenda-1', MeetingID: 'meet-non-existent', Topic: 'Audit Report', Sequence: 1 }],
        MeetingAddress: [{ ID: 'addr-1', Street: '500 Congress Ave', City: 'Austin' }],
      };

      const report = validator.Validate(sampleDomain, data);
      const colGate = report.gates.find((g) => g.name.includes('Composition: Collection Invariants'));
      expect(colGate?.passed).toBe(false);
      expect(colGate?.message).toContain('1 items in collection CommitteeAgendaItem do not reference a valid CommitteeMeeting');
    });

    it('fails when embed reference points to non-existent child', () => {
      const validator = new Validator();
      const data: Record<string, readonly Record<string, unknown>[]> = {
        OrderLine: [{ ID: 'pk-1', OrderID: 'ord-1', ProductID: 'prod-1', Quantity: 1 }],
        EventOrderLine: [{ ID: 'pk-1', PersonID: 'p-1', BadgeName: 'Speaker' }],
        CommitteeMeeting: [{ ID: 'meet-1', Title: 'Finance Committee', LocationAddressID: 'addr-missing' }],
        CommitteeAgendaItem: [{ ID: 'agenda-1', MeetingID: 'meet-1', Topic: 'Audit Report', Sequence: 1 }],
        MeetingAddress: [{ ID: 'addr-1', Street: '500 Congress Ave', City: 'Austin' }],
      };

      const report = validator.Validate(sampleDomain, data);
      const embedGate = report.gates.find((g) => g.name.includes('Composition: Embed Invariants'));
      expect(embedGate?.passed).toBe(false);
      expect(embedGate?.message).toContain('1 embedded references in CommitteeMeeting.LocationAddressID missing in MeetingAddress');
    });
  });
});
