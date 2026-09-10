import { RngStream } from '../math/rng.js';

export interface OrderReversalLine {
  ID: string;
  OrderHeaderID: string;
  ProductID: string;
  CompanyID?: string;
  LineNumber?: number;
  Quantity: number;
  UnitPrice: number;
  LineTotalNet: number;
  LineTotalGross: number;
  ReversesOrderLineID?: string | null;
  FulfillmentStatus?: string;
  Description?: string;
  [key: string]: unknown;
}

export interface OrderReversalHeader {
  ID: string;
  OrderNumber: string;
  OrderType: string;
  OrderDate: string;
  Status: string;
  CompanyID?: string;
  BillToPersonID?: string;
  ShipToPersonID?: string;
  TotalGross: number;
  AmountPaid: number;
  Balance: number;
  ReversesOrderHeaderID?: string | null;
  ReversedByOrderHeaderID?: string | null;
  ReversalReason?: string | null;
  FulfillmentStatus?: string;
  Origin?: string;
  collections?: {
    Lines?: OrderReversalLine[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface UnrollReversalsOptions {
  orders: Record<string, unknown>[];
  orderLines?: Record<string, unknown>[];
  rng?: RngStream;
}

export interface UnrollReversalsResult {
  orders: Record<string, unknown>[];
  orderLines: Record<string, unknown>[];
  reversalsCount: number;
  coherentCount: number;
}

function getField(row: Record<string, unknown>, key: string): unknown {
  const fields = row['fields'] as Record<string, unknown> | undefined;
  if (fields && fields[key] !== undefined) return fields[key];
  const pk = row['primaryKey'] as Record<string, unknown> | undefined;
  if (pk && pk[key] !== undefined) return pk[key];
  return row[key];
}

function setField(row: Record<string, unknown>, key: string, val: unknown): void {
  const fields = row['fields'] as Record<string, unknown> | undefined;
  if (fields) {
    fields[key] = val;
  } else {
    row[key] = val;
  }
}

function getId(row: Record<string, unknown>): string {
  const pk = row['primaryKey'] as Record<string, unknown> | undefined;
  if (pk && pk['ID']) return String(pk['ID']);
  if (pk && pk['id']) return String(pk['id']);
  const fields = row['fields'] as Record<string, unknown> | undefined;
  if (fields && fields['ID']) return String(fields['ID']);
  if (fields && fields['id']) return String(fields['id']);
  return String(row['ID'] ?? row['id'] ?? '');
}

/**
 * ReversalEngine: enforces MemberJunction accounting invariants for order cancellations
 * and line reversals (ReversalBehavior.ts).
 */
export class ReversalEngine {
  /**
   * Unrolls and coheres order cancellations in a dataset.
   * Ensures 100% of cancellation orders:
   * - Reverse a confirmed Sale order from the same customer (BillToPersonID)
   * - Carry an OrderDate >= the original order's OrderDate
   * - Mirror original lines with negative quantities, matching ProductID, and negative totals
   * - Have negative TotalGross and negative AmountPaid (refunded), with Balance = 0
   * - Enforce 1:1 reversal pairing with no double-reversals
   */
  public static CoherifyCancellations(options: UnrollReversalsOptions): UnrollReversalsResult {
    const orders = options.orders;
    const separateLines = options.orderLines ?? [];

    // Group lines by OrderHeaderID
    const linesByOrderId = new Map<string, Record<string, unknown>[]>();
    for (const line of separateLines) {
      const oid = String(getField(line, 'OrderHeaderID') ?? getField(line, 'orderHeaderId') ?? '').toLowerCase();
      if (oid) {
        let list = linesByOrderId.get(oid);
        if (!list) {
          list = [];
          linesByOrderId.set(oid, list);
        }
        list.push(line);
      }
    }

    // Helper to get lines of an order (composed in collections.Lines or from separate lines)
    const getOrderLines = (order: Record<string, unknown>): Record<string, unknown>[] => {
      const id = getId(order).toLowerCase();
      const collections = order['collections'] as { Lines?: Record<string, unknown>[] } | undefined;
      if (collections?.Lines && Array.isArray(collections.Lines) && collections.Lines.length > 0) {
        return collections.Lines;
      }
      return linesByOrderId.get(id) ?? [];
    };

    // Index all orders by ID
    const orderById = new Map<string, Record<string, unknown>>();
    for (const o of orders) {
      const id = getId(o).toLowerCase();
      if (id) orderById.set(id, o);
    }

    // Identify candidate confirmed sales and cancellation orders
    const confirmedSales: Record<string, unknown>[] = [];
    const cancellations: Record<string, unknown>[] = [];

    for (const o of orders) {
      const type = String(getField(o, 'OrderType') ?? '');
      const status = String(getField(o, 'Status') ?? getField(o, 'OrderStatus') ?? '');
      const revId = getField(o, 'ReversesOrderHeaderID');

      if (type === 'Cancellation' || type === 'Return' || (revId !== undefined && revId !== null && revId !== '')) {
        cancellations.push(o);
      } else if (type === 'Sale' && status === 'Confirmed') {
        confirmedSales.push(o);
      }
    }

    // Track claimed sales to enforce strictly 1:1 reversals
    const claimedSales = new Set<string>();

    let coherentCount = 0;

    for (const cancellation of cancellations) {
      const cancelId = getId(cancellation);
      const cancelLines = getOrderLines(cancellation);
      const neededLineCount = cancelLines.length;

      const rawTargetId = getField(cancellation, 'ReversesOrderHeaderID')
        ? String(getField(cancellation, 'ReversesOrderHeaderID')).toLowerCase()
        : null;

      let originalOrder: Record<string, unknown> | undefined;

      // 1. Check if existing ReversesOrderHeaderID points to a valid confirmed sale with matching line count
      if (rawTargetId && orderById.has(rawTargetId)) {
        const target = orderById.get(rawTargetId)!;
        const targetType = String(getField(target, 'OrderType') ?? '');
        const targetStatus = String(getField(target, 'Status') ?? getField(target, 'OrderStatus') ?? '');
        const targetLines = getOrderLines(target);
        const lineCountMatches = neededLineCount === 0 || targetLines.length === neededLineCount;
        if (targetType === 'Sale' && targetStatus === 'Confirmed' && !claimedSales.has(rawTargetId) && lineCountMatches) {
          originalOrder = target;
        }
      }

      // 2. If no valid target yet, find the best confirmed sale for this customer with matching line count
      const cancelCustomer = String(
        getField(cancellation, 'BillToPersonID') ?? getField(cancellation, 'CustomerID') ?? getField(cancellation, 'BillToOrganizationID') ?? ''
      );
      if (!originalOrder && cancelCustomer) {
        const customerSales = confirmedSales.filter((s) => {
          const sId = getId(s).toLowerCase();
          const sCust = String(getField(s, 'BillToPersonID') ?? getField(s, 'CustomerID') ?? getField(s, 'BillToOrganizationID') ?? '');
          const sLines = getOrderLines(s);
          const lineMatches = neededLineCount === 0 || sLines.length === neededLineCount;
          return (
            sCust === cancelCustomer &&
            !claimedSales.has(sId) &&
            sId !== cancelId.toLowerCase() &&
            lineMatches
          );
        });

        if (customerSales.length > 0) {
          customerSales.sort((a, b) => String(getField(a, 'OrderDate') ?? '').localeCompare(String(getField(b, 'OrderDate') ?? '')));
          originalOrder = customerSales[0];
        }
      }

      // 3. Fallback: pair with any unclaimed confirmed sale and align customer
      if (!originalOrder) {
        const available = confirmedSales.filter((s) => {
          const sId = getId(s).toLowerCase();
          const sLines = getOrderLines(s);
          const lineMatches = neededLineCount === 0 || sLines.length === neededLineCount;
          return !claimedSales.has(sId) && sId !== cancelId.toLowerCase() && lineMatches;
        });
        if (available.length > 0) {
          const orig = available[0]!;
          originalOrder = orig;
          // Align customer to match original order
          if (getField(orig, 'BillToPersonID')) setField(cancellation, 'BillToPersonID', getField(orig, 'BillToPersonID'));
          if (getField(orig, 'CustomerID')) setField(cancellation, 'CustomerID', getField(orig, 'CustomerID'));
          if (getField(orig, 'ShipToPersonID')) {
            setField(cancellation, 'ShipToPersonID', getField(orig, 'ShipToPersonID'));
          }
          if (getField(orig, 'CompanyID')) {
            setField(cancellation, 'CompanyID', getField(orig, 'CompanyID'));
          }
        }
      }

      if (!originalOrder) {
        continue;
      }

      const originalId = getId(originalOrder).toLowerCase();
      claimedSales.add(originalId);

      // Link headers
      setField(cancellation, 'OrderType', 'Cancellation');
      setField(cancellation, 'Status', 'Confirmed');
      if (getField(cancellation, 'OrderStatus') !== undefined) {
        setField(cancellation, 'OrderStatus', 'Confirmed');
      }
      setField(cancellation, 'ReversesOrderHeaderID', getId(originalOrder));
      setField(originalOrder, 'ReversedByOrderHeaderID', getId(cancellation));

      // Ensure customer matches
      if (getField(originalOrder, 'BillToPersonID')) setField(cancellation, 'BillToPersonID', getField(originalOrder, 'BillToPersonID'));
      if (getField(originalOrder, 'CustomerID')) setField(cancellation, 'CustomerID', getField(originalOrder, 'CustomerID'));
      if (getField(originalOrder, 'ShipToPersonID')) {
        setField(cancellation, 'ShipToPersonID', getField(originalOrder, 'ShipToPersonID'));
      }
      if (getField(originalOrder, 'CompanyID')) {
        setField(cancellation, 'CompanyID', getField(originalOrder, 'CompanyID'));
      }

      // Ensure date coherence: Cancellation OrderDate >= Original OrderDate
      const origDateStr = String(getField(originalOrder, 'OrderDate') ?? '2019-01-01');
      let cancelDateStr = String(getField(cancellation, 'OrderDate') ?? '');
      if (!cancelDateStr || cancelDateStr < origDateStr) {
        const origDate = new Date(origDateStr);
        origDate.setDate(origDate.getDate() + 7);
        const y = origDate.getFullYear();
        const m = String(origDate.getMonth() + 1).padStart(2, '0');
        const d = String(origDate.getDate()).padStart(2, '0');
        cancelDateStr = `${y}-${m}-${d}`;
        setField(cancellation, 'OrderDate', cancelDateStr);
        setField(cancellation, 'DueDate', cancelDateStr);
      }

      // Set Reversal reason
      if (!getField(cancellation, 'ReversalReason')) {
        setField(cancellation, 'ReversalReason', 'Customer withdrawal within refund policy window');
      }
      setField(cancellation, 'FulfillmentStatus', 'Returned');

      // Mirror lines from original order
      const origLines = getOrderLines(originalOrder);

      const mirroredLines: Record<string, unknown>[] = [];
      let totalNegativeGross = 0;

      for (let idx = 0; idx < origLines.length; idx++) {
        const ol = origLines[idx]!;
        const olId = getId(ol);
        const rawQty = getField(ol, 'Quantity');
        const qty = typeof rawQty === 'number' ? rawQty : 1;
        const rawPrice = getField(ol, 'UnitPrice');
        const unitPrice = typeof rawPrice === 'number' ? rawPrice : 0;
        const rawNet = getField(ol, 'LineTotalNet');
        const origNet = typeof rawNet === 'number' ? rawNet : qty * unitPrice;
        const rawGross = getField(ol, 'LineTotalGross');
        const origGross = typeof rawGross === 'number' ? rawGross : origNet;

        const negQty = -1 * Math.abs(qty);
        const negNet = -1 * Math.abs(origNet);
        const negGross = -1 * Math.abs(origGross);
        totalNegativeGross += negGross;

        // Existing cancellation line to reuse ID or generate one
        const existingLine = cancelLines[idx];
        const lineId = existingLine ? getId(existingLine) : `${cancelId}-LINE-${idx + 1}`;

        let mirroredLine: Record<string, unknown>;
        if (existingLine && existingLine['fields']) {
          const exFields = (existingLine['fields'] as Record<string, unknown>) ?? {};
          mirroredLine = {
            ...existingLine,
            primaryKey: existingLine['primaryKey'] ?? { ID: lineId },
            fields: {
              ...exFields,
              OrderHeaderID: getId(cancellation),
              ProductID: getField(ol, 'ProductID'),
              CompanyID: getField(ol, 'CompanyID') ?? getField(cancellation, 'CompanyID'),
              LineNumber: idx + 1,
              Quantity: negQty,
              UnitPrice: unitPrice,
              DiscountPct: getField(ol, 'DiscountPct') ?? 0,
              DiscountAmount: getField(ol, 'DiscountAmount') ?? 0,
              ChargeAmount: 0,
              LineTax: 0,
              IsRollupParent: false,
              IsQuantityOverridden: false,
              FulfillmentStatus: 'Returned',
              Description: 'Refund',
              LineTotalNet: negNet,
              LineTotalGross: negGross,
              ReversesOrderLineID: olId,
            },
          };
        } else {
          mirroredLine = {
            ...(existingLine ?? {}),
            ID: lineId,
            OrderHeaderID: getId(cancellation),
            ProductID: getField(ol, 'ProductID'),
            CompanyID: getField(ol, 'CompanyID') ?? getField(cancellation, 'CompanyID'),
            LineNumber: idx + 1,
            Quantity: negQty,
            UnitPrice: unitPrice,
            DiscountPct: getField(ol, 'DiscountPct') ?? 0,
            DiscountAmount: getField(ol, 'DiscountAmount') ?? 0,
            ChargeAmount: 0,
            LineTax: 0,
            IsRollupParent: false,
            IsQuantityOverridden: false,
            FulfillmentStatus: 'Returned',
            Description: 'Refund',
            LineTotalNet: negNet,
            LineTotalGross: negGross,
            ReversesOrderLineID: olId,
          };
        }

        mirroredLines.push(mirroredLine);
      }

      // Financial rollup on Cancellation Order
      setField(cancellation, 'TotalGross', totalNegativeGross);
      setField(cancellation, 'AmountPaid', totalNegativeGross); // fully refunded
      setField(cancellation, 'Balance', 0);

      // Update lines on cancellation order
      const cancelCollections = cancellation['collections'] as { Lines?: Record<string, unknown>[] } | undefined;
      if (cancelCollections) {
        cancelCollections.Lines = mirroredLines;
      }
      linesByOrderId.set(cancelId.toLowerCase(), mirroredLines);

      coherentCount++;
    }

    // Reconstruct flat orderLines if separate lines were provided
    const updatedOrderLines: Record<string, unknown>[] = [];
    for (const [_, lines] of linesByOrderId.entries()) {
      updatedOrderLines.push(...lines);
    }
    if (options.orderLines) {
      options.orderLines.length = 0;
      options.orderLines.push(...updatedOrderLines);
    }

    return {
      orders,
      orderLines: updatedOrderLines,
      reversalsCount: cancellations.length,
      coherentCount,
    };
  }
}
