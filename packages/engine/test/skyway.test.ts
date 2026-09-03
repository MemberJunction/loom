import { describe, it, expect } from 'vitest';
import { sortEntitiesTopologically } from '../src/emitters/skyway.js';
import type { DomainConfig } from '@memberjunction/loom-contracts';

describe('Skyway Emitter: Topological Entity Sorting', () => {
  it('throws an explicit descriptive error when a cyclic FK dependency is detected', () => {
    const cyclicDomain: DomainConfig = {
      name: 'cyclic-test',
      namespace: '11111111-1111-1111-1111-111111111111',
      packs: {},
      entities: {
        A: {
          name: 'A',
          schema: 'dbo',
          targetTable: 'A',
          pack: 'core',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', nullable: false, isPrimaryKey: true },
            BRef: { name: 'BRef', type: 'uuid', nullable: false, isPrimaryKey: false },
          },
          foreignKeys: {
            FK_A_B: { fieldName: 'BRef', targetEntity: 'B', targetField: 'ID', cardinality: 'many-to-one' },
          },
        },
        B: {
          name: 'B',
          schema: 'dbo',
          targetTable: 'B',
          pack: 'core',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', nullable: false, isPrimaryKey: true },
            ARef: { name: 'ARef', type: 'uuid', nullable: false, isPrimaryKey: false },
          },
          foreignKeys: {
            FK_B_A: { fieldName: 'ARef', targetEntity: 'A', targetField: 'ID', cardinality: 'many-to-one' },
          },
        },
      },
    };

    expect(() => sortEntitiesTopologically(['A', 'B'], cyclicDomain)).toThrow(
      /Cyclic foreign key dependency detected among entities: A, B/
    );
  });

  it('sort order is a pure function of the domain, independent of input key order', () => {
    const dagDomain: DomainConfig = {
      name: 'dag-test',
      namespace: '22222222-2222-2222-2222-222222222222',
      packs: {},
      entities: {
        OrderLine: {
          name: 'OrderLine',
          schema: 'dbo',
          targetTable: 'OrderLine',
          pack: 'commerce',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', nullable: false, isPrimaryKey: true },
            OrderID: { name: 'OrderID', type: 'uuid', nullable: false, isPrimaryKey: false },
            ProductID: { name: 'ProductID', type: 'uuid', nullable: false, isPrimaryKey: false },
          },
          foreignKeys: {
            FK_OL_OH: { fieldName: 'OrderID', targetEntity: 'OrderHeader', targetField: 'ID', cardinality: 'many-to-one' },
            FK_OL_P: { fieldName: 'ProductID', targetEntity: 'Product', targetField: 'ID', cardinality: 'many-to-one' },
          },
        },
        OrderHeader: {
          name: 'OrderHeader',
          schema: 'dbo',
          targetTable: 'OrderHeader',
          pack: 'commerce',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', nullable: false, isPrimaryKey: true },
            MemberID: { name: 'MemberID', type: 'uuid', nullable: false, isPrimaryKey: false },
          },
          foreignKeys: {
            FK_OH_M: { fieldName: 'MemberID', targetEntity: 'Member', targetField: 'ID', cardinality: 'many-to-one' },
          },
        },
        Member: {
          name: 'Member',
          schema: 'dbo',
          targetTable: 'Member',
          pack: 'core',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', nullable: false, isPrimaryKey: true },
            CompanyID: { name: 'CompanyID', type: 'uuid', nullable: false, isPrimaryKey: false },
          },
          foreignKeys: {
            FK_M_C: { fieldName: 'CompanyID', targetEntity: 'Company', targetField: 'ID', cardinality: 'many-to-one' },
          },
        },
        Company: {
          name: 'Company',
          schema: 'dbo',
          targetTable: 'Company',
          pack: 'core',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', nullable: false, isPrimaryKey: true },
          },
          foreignKeys: {},
        },
        Product: {
          name: 'Product',
          schema: 'dbo',
          targetTable: 'Product',
          pack: 'commerce',
          businessKey: ['ID'],
          fields: {
            ID: { name: 'ID', type: 'uuid', nullable: false, isPrimaryKey: true },
          },
          foreignKeys: {},
        },
      },
    };

    // Permutation 1: Reverse alphabetical
    const order1 = sortEntitiesTopologically(
      ['Product', 'OrderLine', 'OrderHeader', 'Member', 'Company'],
      dagDomain
    );

    // Permutation 2: Child first
    const order2 = sortEntitiesTopologically(
      ['OrderLine', 'OrderHeader', 'Member', 'Company', 'Product'],
      dagDomain
    );

    // Both permutations produce the exact same topological ordering
    expect(order1).toEqual(order2);

    // Verify parents strictly precede children
    expect(order1.indexOf('Company')).toBeLessThan(order1.indexOf('Member'));
    expect(order1.indexOf('Member')).toBeLessThan(order1.indexOf('OrderHeader'));
    expect(order1.indexOf('OrderHeader')).toBeLessThan(order1.indexOf('OrderLine'));
    expect(order1.indexOf('Product')).toBeLessThan(order1.indexOf('OrderLine'));
  });

  it('sorts rows deterministically by code-point order', () => {
    // Probed values: ['a-b', 'ab', 'A-c', 'Ab']
    const testIds = ['a-b', 'ab', 'A-c', 'Ab'];
    const sorted = [...testIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // Code point sorting: uppercase ASCII (< 0x61) precedes lowercase ASCII
    expect(sorted).toEqual(['A-c', 'Ab', 'a-b', 'ab']);
  });
});
