import { describe, it, expect } from 'vitest';
import { parseCsv, parseRentRollCsv } from '../ingest/rentRollCsv';
import {
  mergeListing, assembleListings, listingKey, SOURCE_TRUST, CONFLICT_TOLERANCE,
} from '../ingest/listing';
import { analyseRentRoll } from '../rentRoll';

/**
 * Ingestion.
 *
 * Organised around the ways an importer silently corrupts a deal, which is a
 * different list from the ways it can throw:
 *
 *   1. An unreadable value becomes a zero, and the deal looks like a value-add.
 *   2. A totals row becomes a tenant holding half the rent.
 *   3. Four sources for one property become four listings, each incomplete.
 *   4. Two sources disagree and the merge quietly picks one.
 */

// ─── 1. Nothing unreadable becomes a number ──────────────────────────────────

describe('an unparsed value is reported, never coerced', () => {
  it('a broken rent cell does not become zero rent', () => {
    // This is the failure that matters most. A bay whose rent read as 0 makes a
    // fully-let centre look like it has upside, which is the exact story a
    // buyer wants to believe.
    const csv = [
      'Tenant,SF,Annual Rent',
      'Clip Joint,1600,33600',
      'Valley Dental,2000,see lease',
    ].join('\n');
    const { bays, issues } = parseRentRollCsv(csv);

    expect(bays[1].baseRentAnnual).toBeUndefined();     // absent, not 0
    const flagged = issues.find((i) => i.kind === 'missing' && i.line === 3);
    expect(flagged).toBeTruthy();
    expect(flagged.tenant).toBe('Valley Dental');

    // And downstream, the bay is excluded rather than counted at zero: rent per
    // SF stays at the real rate instead of being halved by a phantom free bay.
    const r = analyseRentRoll(bays);
    expect(r.inPlaceRentPSF).toBeCloseTo(21, 5);
  });

  it('an unreadable square footage is flagged, not zeroed', () => {
    const { bays, issues } = parseRentRollCsv('Tenant,SF,Annual Rent\nA,approx 1600,33600');
    expect(bays[0].squareFeet).toBeNull();
    expect(issues.find((i) => i.kind === 'unparsed' && i.field === 'squareFeet')).toBeTruthy();
  });

  it('accounting negatives keep their sign', () => {
    // (1,200) is -1200 in every rent roll an accountant produced. Reading it as
    // 1200 flips a concession into income.
    const { bays } = parseRentRollCsv('Tenant,SF,Annual Rent\nA,1000,"(1,200)"');
    expect(bays[0].baseRentAnnual).toBe(-1200);
  });

  it('rent given per SF with no SF is refused rather than guessed', () => {
    const { bays, issues } = parseRentRollCsv('Tenant,SF,Rent PSF\nA,,22');
    expect(bays[0].baseRentAnnual).toBeUndefined();
    expect(issues.find((i) => i.kind === 'unusable' && i.field === 'rentPSF')).toBeTruthy();
  });

  it('derived rent says it was derived', () => {
    const { bays } = parseRentRollCsv('Tenant,SF,Monthly Rent\nA,1600,2800');
    expect(bays[0].baseRentAnnual).toBe(33600);
    expect(bays[0].rentBasis).toBe('monthly×12');
  });
});

// ─── 2. Rows that are not bays ───────────────────────────────────────────────

describe('a rent roll is not just its rows', () => {
  it('a totals row does not become a tenant', () => {
    // Left in, it doubles the rent and creates a phantom tenant holding 50% of
    // it — so the concentration test fails a roll that is actually fine.
    const csv = [
      'Tenant,SF,Annual Rent',
      'A,1000,20000',
      'B,1000,20000',
      'TOTAL,2000,40000',
    ].join('\n');
    const { bays } = parseRentRollCsv(csv);
    expect(bays).toHaveLength(2);
    const r = analyseRentRoll(bays);
    expect(r.grossBaseRent).toBe(40000);
    expect(r.largestTenantShare).toBeCloseTo(50, 5);   // not 50 of 80,000
  });

  it('finds the header when the file opens with a title', () => {
    // Almost every rent roll does this, and a parser that assumes row 1 is the
    // header reads the title as column names and every real row as data.
    const csv = [
      'Maple Crossing — Rent Roll as of 3/1/2026',
      '',
      'Tenant,Suite,SF,Annual Rent',
      'Clip Joint,101,1600,33600',
    ].join('\n');
    const { bays, issues } = parseRentRollCsv(csv);
    expect(bays).toHaveLength(1);
    expect(bays[0].tenant).toBe('Clip Joint');
    expect(issues.find((i) => i.kind === 'no-header')).toBeFalsy();
  });

  it('a vacant bay is a bay, not a tenant called Vacant', () => {
    const { bays } = parseRentRollCsv('Tenant,SF,Annual Rent\nVACANT,1200,');
    expect(bays[0].vacant).toBe(true);
    expect(bays[0].tenant).toBeUndefined();
    expect(analyseRentRoll(bays).vacantBays).toBe(1);
  });

  it('commas inside a tenant name do not split the row', () => {
    const csv = 'Tenant,SF,Annual Rent\n"Smith, Jones & Co",1400,28000';
    const { bays } = parseRentRollCsv(csv);
    expect(bays[0].tenant).toBe('Smith, Jones & Co');
    expect(bays[0].baseRentAnnual).toBe(28000);
  });

  it('refuses a file it cannot map rather than inventing a shape', () => {
    const { bays, issues } = parseRentRollCsv('foo,bar,baz\n1,2,3');
    expect(bays).toHaveLength(0);
    const err = issues.find((i) => i.kind === 'no-header');
    expect(err.message).toMatch(/columns: \{/);   // tells you how to fix it
  });

  it('explicit column mapping beats the synonym list', () => {
    const csv = 'Occupant Name,Demised Area,Contract Rent\nClip Joint,1600,33600';
    const { bays } = parseRentRollCsv(csv, {
      columns: {
        'Occupant Name': 'tenant',
        'Demised Area': 'squareFeet',
        'Contract Rent': 'baseRentAnnual',
      },
    });
    expect(bays[0]).toMatchObject({ tenant: 'Clip Joint', squareFeet: 1600, baseRentAnnual: 33600 });
  });

  it('says when it cannot measure tenant mix', () => {
    // Otherwise the restaurant-share criterion comes back `unknown` with no
    // explanation and the user re-reads the buy box looking for the mistake.
    const { issues } = parseRentRollCsv('Tenant,SF,Annual Rent\nA,1000,20000');
    expect(issues.find((i) => i.kind === 'note' && /tenant-use column/.test(i.message))).toBeTruthy();
  });

  it('flags a genuinely ambiguous date and not an unambiguous one', () => {
    const ambiguous = parseRentRollCsv('Tenant,SF,Annual Rent,Expiration\nA,1000,20000,03/04/2029');
    expect(ambiguous.issues.find((i) => i.kind === 'assumption')).toBeTruthy();
    expect(ambiguous.bays[0].leaseEnd).toBe('2029-03-04');   // US, month first

    const clear = parseRentRollCsv('Tenant,SF,Annual Rent,Expiration\nA,1000,20000,03/25/2029');
    expect(clear.issues.find((i) => i.kind === 'assumption')).toBeFalsy();
  });

  it('month-to-month is no expiry, not a broken date', () => {
    const { bays } = parseRentRollCsv('Tenant,SF,Annual Rent,Expiration\nA,1000,20000,MTM');
    expect(bays[0].leaseEnd).toBeUndefined();
    // And WALT stays null rather than counting it as expiring today.
    expect(analyseRentRoll(bays).waltYears).toBeNull();
  });
});

// ─── 3. One property, four sources ───────────────────────────────────────────

describe('deduplication is by address, not by name', () => {
  it('the same centre under three names is one listing', () => {
    const sources = [
      { sourceKind: 'marketing', sourceName: 'teaser', fields: { name: 'Maple Crossing', address: '4500 Maple Avenue', city: 'Columbus', state: 'OH', purchasePrice: 2400000 } },
      { sourceKind: 'marketing', sourceName: 'second broker', fields: { name: 'Maple Crossing Shopping Center', address: '4500 Maple Ave.', city: 'columbus', state: 'oh', yearBuilt: 1998 } },
      { sourceKind: 'public', sourceName: 'Franklin County assessor', fields: { address: '4500 MAPLE AVE', city: 'Columbus', state: 'OH', buildingSize: 11200 } },
    ];
    const listings = assembleListings(sources);
    expect(listings).toHaveLength(1);
    // And the merged record has all three sources' fields.
    expect(listings[0].fields).toMatchObject({
      purchasePrice: 2400000, yearBuilt: 1998, buildingSize: 11200,
    });
  });

  it('a suite number is not a property', () => {
    expect(listingKey({ address: '4500 Maple Ave Suite 101', city: 'Columbus', state: 'OH' }))
      .toBe(listingKey({ address: '4500 Maple Ave', city: 'Columbus', state: 'OH' }));
  });

  it('records with no address are kept apart, not pooled', () => {
    // Pooling them would merge two unrelated properties into one record, which
    // is worse than failing to dedupe.
    const listings = assembleListings([
      { sourceKind: 'marketing', sourceName: 'a', fields: { name: 'One', purchasePrice: 1 } },
      { sourceKind: 'marketing', sourceName: 'b', fields: { name: 'Two', purchasePrice: 2 } },
    ]);
    expect(listings).toHaveLength(2);
    expect(listings.every((l) => l.key === null)).toBe(true);
  });
});

// ─── 4. Sources that disagree ────────────────────────────────────────────────

describe('a conflict is reported, not resolved away', () => {
  const sources = () => [
    { sourceKind: 'marketing', sourceName: 'flyer', asOf: '2026-03-01', fields: { buildingSize: 14000, trafficCount: 25000 } },
    { sourceKind: 'public', sourceName: 'county assessor', asOf: '2025-01-01', fields: { buildingSize: 11200 } },
    { sourceKind: 'public', sourceName: 'state DOT', asOf: '2025-06-01', fields: { trafficCount: 16400 } },
  ];

  it('the more trusted source leads', () => {
    const m = mergeListing(sources());
    expect(m.fields.buildingSize).toBe(11200);       // assessor over flyer
    expect(m.provenance.buildingSize.sourceName).toBe('county assessor');
  });

  it('recency does not beat trust', () => {
    // The flyer is three months newer and was never a measurement.
    const m = mergeListing(sources());
    expect(m.fields.trafficCount).toBe(16400);
    expect(m.provenance.trafficCount.sourceKind).toBe('public');
  });

  it('the losing values survive as a conflict', () => {
    const m = mergeListing(sources());
    const sf = m.conflicts.find((c) => c.field === 'buildingSize');
    expect(sf.leading.value).toBe(11200);
    expect(sf.dissenting[0]).toMatchObject({ value: 14000, source: 'flyer' });
    // 11,200 against 14,000 at $200/SF is $560k of difference in what you are
    // buying, so the spread is quantified rather than left to be eyeballed.
    expect(sf.spreadPct).toBeCloseTo(20, 0);
  });

  it('the widest spread is reported first', () => {
    const m = mergeListing(sources());
    expect(m.conflicts[0].field).toBe('trafficCount');   // 34% vs 20%
  });

  it('an expected divergence is labelled as expected', () => {
    // Gross building area and gross leasable area are both right. There is no
    // ranking that fixes that — only a note so nobody chases a reconciliation
    // that does not exist.
    const m = mergeListing(sources());
    expect(m.conflicts.find((c) => c.field === 'buildingSize').expected)
      .toMatch(/leasable area/);
  });

  it('rounding is not a conflict', () => {
    const m = mergeListing([
      { sourceKind: 'marketing', sourceName: 'a', fields: { buildingSize: 14000 } },
      { sourceKind: 'document', sourceName: 'b', fields: { buildingSize: 14100 } },
    ]);
    expect(14100 / 14000 - 1).toBeLessThan(CONFLICT_TOLERANCE);
    expect(m.conflicts).toHaveLength(0);
  });

  it('cosmetic differences in text are not conflicts', () => {
    const m = mergeListing([
      { sourceKind: 'marketing', sourceName: 'a', fields: { anchorStatus: 'Shadow anchored' } },
      { sourceKind: 'document', sourceName: 'b', fields: { anchorStatus: 'shadow-anchored' } },
    ]);
    expect(m.conflicts).toHaveLength(0);
  });

  it('corroboration is visible', () => {
    // One source agreeing with itself is not corroboration, and a reader should
    // be able to tell how many actually saw the field.
    const m = mergeListing(sources());
    expect(m.provenance.buildingSize.observationCount).toBe(2);
  });

  it('an unknown source kind is an error, not a default', () => {
    expect(() => mergeListing([{ sourceKind: 'vibes', sourceName: 'x', fields: { a: 1 } }]))
      .toThrow(/unknown sourceKind/);
    expect(Object.keys(SOURCE_TRUST)).toContain('measured');
  });
});

// ─── The CSV reader itself ───────────────────────────────────────────────────

describe('csv', () => {
  it('handles quotes, doubled quotes and embedded newlines', () => {
    const rows = parseCsv('a,b\n"x,1","he said ""hi"""\n"multi\nline",2');
    expect(rows[1]).toEqual(['x,1', 'he said "hi"']);
    expect(rows[2]).toEqual(['multi\nline', '2']);
  });

  it('reads tab-separated files too', () => {
    // What you get pasting a spreadsheet selection straight into a text file.
    const { bays } = parseRentRollCsv('Tenant\tSF\tAnnual Rent\nClip Joint\t1600\t33600');
    expect(bays[0]).toMatchObject({ tenant: 'Clip Joint', squareFeet: 1600 });
  });

  it('an empty file is empty, not an error', () => {
    expect(parseRentRollCsv('').bays).toEqual([]);
    expect(parseRentRollCsv('').issues[0].kind).toBe('empty');
  });
});

describe('a number is a number, or it is an issue', () => {
  it('reads the formats a spreadsheet actually produces', () => {
    const cases = [
      ['$33,600', 33600], ['1,600 SF', 1600], ['22.50', 22.5],
      ['2800/mo', 2800], ['18 psf', 18], ['(1,200)', -1200],
    ];
    for (const [raw, want] of cases) {
      const { bays } = parseRentRollCsv(`Tenant,SF,Annual Rent\nA,1000,"${raw}"`);
      expect(bays[0].baseRentAnnual, raw).toBe(want);
    }
  });

  it('refuses text that merely contains a number', () => {
    // The dangerous case is not "approx 1600", it is "Bldg 3" — a parser that
    // extracts a digit from arbitrary text eventually extracts one from a cell
    // that was never a measurement, and downstream it is indistinguishable
    // from a real figure.
    for (const raw of ['approx 1600', 'Bldg 3', 'see lease', '1600 or so', '3 of 12']) {
      const { bays, issues } = parseRentRollCsv(`Tenant,SF,Annual Rent\nA,"${raw}",20000`);
      expect(bays[0].squareFeet, raw).toBeNull();
      expect(issues.some((i) => i.kind === 'unparsed'), raw).toBe(true);
    }
  });

  it('treats the conventional blanks as absent, not as errors', () => {
    for (const raw of ['', 'N/A', '-', 'TBD']) {
      const { bays, issues } = parseRentRollCsv(`Tenant,SF,Annual Rent\nA,"${raw}",20000`);
      expect(bays[0].squareFeet, raw).toBeNull();
      expect(issues.some((i) => i.kind === 'unparsed'), raw).toBe(false);
    }
  });
});

describe('the number shape, pinned', () => {
  // Added because mutation testing showed the shape check was doing work no
  // test proved: `Number()` already rejects obvious garbage, so only these
  // cases distinguish the two.
  const sf = (raw) => parseRentRollCsv(`Tenant,SF,Annual Rent\nA,"${raw}",20000`).bays[0].squareFeet;

  it('rejects hex, which Number would silently accept', () => {
    // Number('0x10') is 16, and a 16 that came from '0x10' is indistinguishable
    // downstream from a measured 16.
    expect(sf('0x10')).toBeNull();
  });

  it('accepts the scientific notation Excel exports', () => {
    // A wide column exports as 1.2E+05 and means 120,000. Rejecting it would
    // flag a real figure as unreadable.
    expect(sf('1.2E+05')).toBe(120000);
  });

  it('accepts a leading sign', () => {
    expect(sf('+40')).toBe(40);
  });

  it('rejects a malformed decimal', () => {
    expect(sf('12.5.6')).toBeNull();
  });
});
