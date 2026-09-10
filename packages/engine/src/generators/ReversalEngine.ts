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
      const oid = String(line['OrderHeaderID'] ?? line['orderHeaderId'] ?? '').toLowerCase();
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
      const id = String(order['ID'] ?? order['id'] ?? '').toLowerCase();
      const collections = order['collections'] as { Lines?: Record<string, unknown>[] } | undefined;
      if (collections?.Lines && Array.isArray(collections.Lines) && collections.Lines.length > 0) {
        return collections.Lines;
      }
      return linesByOrderId.get(id) ?? [];
    };

    // Index all orders by ID
    const orderById = new Map<string, Record<string, unknown>>();
    for (const o of orders) {
      const id = String(o['ID'] ?? o['id'] ?? '').toLowerCase();
      if (id) orderById.set(id, o);
    }

    // Identify candidate confirmed sales and cancellation orders
    const confirmedSales: Record<string, unknown>[] = [];
    const cancellations: Record<string, unknown>[] = [];

    for (const o of orders) {
      const type = String(o['OrderType'] ?? '');
      const status = String(o['Status'] ?? o['OrderStatus'] ?? '');
      const revId = o['ReversesOrderHeaderID'];

      if (type === 'Cancellation' || type === 'Return' || revId !== undefined && revId !== null && revId !== '') {
        cancellations.push(o);
      } else if (type === 'Sale' && status === 'Confirmed') {
        confirmedSales.push(o);
      }
    }

    // Track claimed sales to enforce strictly 1:1 reversals
    const claimedSales = new Set<string>();

    let coherentCount = 0;

    for (const cancellation of cancellations) {
      const cancelId = String(cancellation['ID'] ?? cancellation['id'] ?? '');
      const rawTargetId = cancellation['ReversesOrderHeaderID']
        ? String(cancellation['ReversesOrderHeaderID']).toLowerCase()
        : null;

      let originalOrder: Record<string, unknown> | undefined;

      // 1. Check if existing ReversesOrderHeaderID points to a valid confirmed sale
      if (rawTargetId && orderById.has(rawTargetId)) {
        const target = orderById.get(rawTargetId)!;
        const targetType = String(target['OrderType'] ?? '');
        const targetStatus = String(target['Status'] ?? target['OrderStatus'] ?? '');
        if (targetType === 'Sale' && targetStatus === 'Confirmed' && !claimedSales.has(rawTargetId)) {
          originalOrder = target;
        }
      }

      // 2. If no valid target yet, find the best confirmed sale for this customer
      const cancelCustomer = String(
        cancellation['BillToPersonID'] ?? cancellation['CustomerID'] ?? cancellation['BillToOrganizationID'] ?? ''
      );
      if (!originalOrder && cancelCustomer) {
        const customerSales = confirmedSales.filter((s) => {
          const sId = String(s['ID'] ?? s['id'] ?? '').toLowerCase();
          const sCust = String(s['BillToPersonID'] ?? s['CustomerID'] ?? s['BillToOrganizationID'] ?? '');
          return (
            sCust === cancelCustomer &&
            !claimedSales.has(sId) &&
            sId !== cancelId.toLowerCase()
          );
        });

        if (customerSales.length > 0) {
          // Sort by OrderDate ascending
          customerSales.sort((a, b) => String(a['OrderDate'] ?? '').localeCompare(String(b['OrderDate'] ?? '')));
          originalOrder = customerSales[0];
        }
      }

      // 3. Fallback: pair with any unclaimed confirmed sale and align customer
      if (!originalOrder) {
        const available = confirmedSales.filter((s) => {
          const sId = String(s['ID'] ?? s['id'] ?? '').toLowerCase();
          return !claimedSales.has(sId) && sId !== cancelId.toLowerCase();
        });
        if (available.length > 0) {
          originalOrder = available[0];
          // Align customer to match original order
          if (originalOrder!['BillToPersonID']) cancellation['BillToPersonID'] = originalOrder!['BillToPersonID'];
          if (originalOrder!['CustomerID']) cancellation['CustomerID'] = originalOrder!['CustomerID'];
          if (originalOrder!['ShipToPersonID']) {
            cancellation['ShipToPersonID'] = originalOrder!['ShipToPersonID'];
          }
          if (originalOrder!['CompanyID']) {
            cancellation['CompanyID'] = originalOrder!['CompanyID'];
          }
        }
      }

      if (!originalOrder) {
        continue;
      }

      const originalId = String(originalOrder['ID'] ?? originalOrder['id'] ?? '').toLowerCase();
      claimedSales.add(originalId);

      // Link headers
      cancellation['OrderType'] = 'Cancellation';
      cancellation['Status'] = 'Confirmed';
      if (cancellation['OrderStatus'] !== undefined) {
        cancellation['OrderStatus'] = 'Confirmed';
      }
      cancellation['ReversesOrderHeaderID'] = originalOrder['ID'] ?? originalOrder['id'];
      originalOrder['ReversedByOrderHeaderID'] = cancellation['ID'] ?? cancellation['id'];

      // Ensure customer matches
      if (originalOrder['BillToPersonID']) cancellation['BillToPersonID'] = originalOrder['BillToPersonID'];
      if (originalOrder['CustomerID']) cancellation['CustomerID'] = originalOrder['CustomerID'];
      if (originalOrder['ShipToPersonID']) {
        cancellation['ShipToPersonID'] = originalOrder['ShipToPersonID'];
      }
      if (originalOrder['CompanyID']) {
        cancellation['CompanyID'] = originalOrder['CompanyID'];
      }

      // Ensure date coherence: Cancellation OrderDate >= Original OrderDate
      const origDateStr = String(originalOrder['OrderDate'] ?? '2019-01-01');
      let cancelDateStr = String(cancellation['OrderDate'] ?? '');
      if (!cancelDateStr || cancelDateStr < origDateStr) {
        const origDate = new Date(origDateStr);
        origDate.setDate(origDate.getDate() + 7);
        const y = origDate.getFullYear();
        const m = String(origDate.getMonth() + 1).padStart(2, '0');
        const d = String(origDate.getDate()).padStart(2, '0');
        cancelDateStr = `${y}-${m}-${d}`;
        cancellation['OrderDate'] = cancelDateStr;
        cancellation['DueDate'] = cancelDateStr;
      }

      // Set Reversal reason
      if (!cancellation['ReversalReason']) {
        cancellation['ReversalReason'] = 'Course seat withdrawal within accredited refund window';
      }
      cancellation['FulfillmentStatus'] = 'Returned';

      // Mirror lines from original order
      const origLines = getOrderLines(originalOrder);
      const cancelLines = getOrderLines(cancellation);

      const mirroredLines: Record<string, unknown>[] = [];
      let totalNegativeGross = 0;

      for (let idx = 0; idx < origLines.length; idx++) {
        const ol = origLines[idx]!;
        const olId = String(ol['ID'] ?? ol['id'] ?? '');
        const qty = typeof ol['Quantity'] === 'number' ? ol['Quantity'] : 1;
        const unitPrice = typeof ol['UnitPrice'] === 'number' ? ol['UnitPrice'] : 0;
        const origNet = typeof ol['LineTotalNet'] === 'number' ? ol['LineTotalNet'] : qty * unitPrice;
        const origGross = typeof ol['LineTotalGross'] === 'number' ? ol['LineTotalGross'] : origNet;

        const negQty = -1 * Math.abs(qty);
        const negNet = -1 * Math.abs(origNet);
        const negGross = -1 * Math.abs(origGross);
        totalNegativeGross += negGross;

        // Existing cancellation line to reuse ID or generate one
        const existingLine = cancelLines[idx];
        const lineId = existingLine
          ? String(existingLine['ID'] ?? existingLine['id'] ?? '')
          : `${cancelId}-LINE-${idx + 1}`;

        const mirroredLine: Record<string, unknown> = {
          ...(existingLine ?? {}),
          ID: lineId,
          OrderHeaderID: cancellation['ID'] ?? cancellation['id'],
          ProductID: ol['ProductID'],
          CompanyID: ol['CompanyID'] ?? cancellation['CompanyID'],
          LineNumber: idx + 1,
          Quantity: negQty,
          UnitPrice: unitPrice,
          DiscountPct: ol['DiscountPct'] ?? 0,
          DiscountAmount: ol['DiscountAmount'] ?? 0,
          ChargeAmount: 0,
          LineTax: 0,
          IsRollupParent: false,
          IsQuantityOverridden: false,
          FulfillmentStatus: 'Returned',
          Description: ol['Description'] ? `Refund: ${ol['Description']}` : 'Refund',
          LineTotalNet: negNet,
          LineTotalGross: negGross,
          ReversesOrderLineID: olId,
        };

        mirroredLines.push(mirroredLine);
      }

      // Financial rollup on Cancellation Order
      cancellation['TotalGross'] = totalNegativeGross;
      cancellation['AmountPaid'] = totalNegativeGross; // fully refunded
      cancellation['Balance'] = 0;

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
