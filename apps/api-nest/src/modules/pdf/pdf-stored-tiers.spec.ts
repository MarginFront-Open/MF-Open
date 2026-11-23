/**
 * A stored invoice can explain its own blended price.
 *
 * A credit-pool row prints "400 × $0.25 = $99.00" because numeric(12,2) cannot
 * hold the real $0.2475 per credit. The arithmetic reads wrong to the customer
 * even though the money is exact. The breakdown that explains it is written on
 * the row (invoice.utils.ts stores tiersUsed inside metadata), and the PDF's
 * stored-row branch must read it from there to show it.
 */
import { tierRowsFromMetadata } from './pdf.service';

describe('tierRowsFromMetadata', () => {
  it('finds the breakdown where the line-item writer puts it', () => {
    const rows = tierRowsFromMetadata({
      effectiveUnitPrice: 0.2475,
      tiersUsed: [
        { lower: 0, upper: 1000, rate: 99, quantity: 400, subtotal: 99 },
        { lower: 1000, upper: null, rate: 0.03, quantity: 0, subtotal: 0 },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].subtotal).toBe(99);
    expect(rows[1].upper).toBeNull();
  });

  it('reads a row with no breakdown as no breakdown', () => {
    expect(tierRowsFromMetadata({ effectiveUnitPrice: 50 })).toEqual([]);
    expect(tierRowsFromMetadata({})).toEqual([]);
    expect(tierRowsFromMetadata(null)).toEqual([]);
    expect(tierRowsFromMetadata(undefined)).toEqual([]);
  });

  it('never throws on a metadata blob that is not what we expect', () => {
    // The column is free-form Json. Anything can be in there, and PDF
    // generation must not be the thing that discovers it.
    expect(tierRowsFromMetadata('not-an-object')).toEqual([]);
    expect(tierRowsFromMetadata([1, 2, 3])).toEqual([]);
    expect(tierRowsFromMetadata({ tiersUsed: 'nope' })).toEqual([]);
    expect(tierRowsFromMetadata({ tiersUsed: [null, 7, { rate: 1 }] })).toEqual([]);
  });
});
