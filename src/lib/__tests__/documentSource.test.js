import { describe, it, expect } from 'vitest';
import {
  documentSource, unreviewedSource, listingSources, unmappedFields,
  LISTING_FIELD_MAP, UNMAPPED_REASONS, isUnreviewedSourceName,
} from '../ingest/documentSource';
import { mergeListing, SOURCE_TRUST } from '../ingest/listing';
import { initialReview, confirm, reject, edit } from '../ingest/review';
import { FIELDS, FIELD_NAMES } from '../../extraction/schema';
import { FIXTURE_DOCUMENT, fixturePredictions } from './fixtures/reviewFixtures';

const fields = FIELDS.map((f) => ({ ...f, label: f.name, measured: true }));
const preds = fixturePredictions();
const start = () => initialReview(preds, fields);

describe('the mapping', () => {
  it('every extraction field is either mapped or listed as unmapped with a reason', () => {
    for (const name of FIELD_NAMES) {
      expect(Boolean(LISTING_FIELD_MAP[name]) !== Boolean(UNMAPPED_REASONS[name])).toBe(true);
    }
  });

  it('names the fields listing.js knows', () => {
    expect(LISTING_FIELD_MAP.squareFeet).toBe('buildingSize');
    expect(LISTING_FIELD_MAP.occupancy).toBe('occupancyPct');
  });

  it('reports which extracted fields had nowhere to go', () => {
    const r = edit(start(), 'capRate', 6.25);
    expect(unmappedFields(preds, r)).toEqual(['capRate']);
  });
});

describe('reviewed source', () => {
  it('is document tier and carries only confirmed and edited values', () => {
    let r = start();
    r = confirm(r, 'squareFeet');
    r = edit(r, 'yearBuilt', 1999);
    r = reject(r, 'purchasePrice');
    const s = documentSource(FIXTURE_DOCUMENT, r);
    expect(s.sourceKind).toBe('document');
    expect(s.sourceName).toBe('fixture-offering-memo.pdf');
    expect(s.fields).toEqual({ buildingSize: 12400, yearBuilt: 1999 });
  });

  it('pending values never enter the reviewed source', () => {
    expect(documentSource(FIXTURE_DOCUMENT, start()).fields).toEqual({});
  });

  it('does not take asOf from the upload time', () => {
    expect(documentSource(FIXTURE_DOCUMENT, confirm(start(), 'address')).asOf).toBeNull();
  });

  it('drops unmapped fields', () => {
    const s = documentSource(FIXTURE_DOCUMENT, edit(start(), 'capRate', 6.25));
    expect(s.fields).not.toHaveProperty('capRate');
  });
});

describe('unreviewed source', () => {
  it('is estimate tier, named unreviewed, and holds only pending values', () => {
    const r = reject(confirm(start(), 'squareFeet'), 'purchasePrice');
    const s = unreviewedSource(FIXTURE_DOCUMENT, preds, r);
    expect(s.sourceKind).toBe('estimate');
    expect(SOURCE_TRUST[s.sourceKind]).toBeLessThan(SOURCE_TRUST.document);
    expect(isUnreviewedSourceName(s.sourceName)).toBe(true);
    expect(s.fields).toEqual({
      address: '100 Fixture Way, Testville, OH', yearBuilt: 1998, occupancyPct: 92,
    });
  });

  it('is left out unless asked for', () => {
    expect(listingSources(FIXTURE_DOCUMENT, preds, start())).toEqual([]);
    const both = listingSources(FIXTURE_DOCUMENT, preds, start(), { includeUnreviewed: true });
    expect(both).toHaveLength(1);
    expect(both[0].sourceKind).toBe('estimate');
  });
});

describe('merging with other sources', () => {
  const assessor = { sourceKind: 'public', sourceName: 'fixture assessor', fields: { buildingSize: 11200 } };
  const flyer = { sourceKind: 'marketing', sourceName: 'fixture flyer', fields: { occupancyPct: 100 } };

  it('a confirmed value conflicting with the assessor is recorded, not resolved', () => {
    const r = confirm(start(), 'squareFeet');
    const m = mergeListing([assessor, ...listingSources(FIXTURE_DOCUMENT, preds, r)]);
    const c = m.conflicts.find((x) => x.field === 'buildingSize');
    expect(c.leading).toMatchObject({ value: 11200, kind: 'public' });
    expect(c.dissenting[0]).toMatchObject({ value: 12400, source: 'fixture-offering-memo.pdf', kind: 'document' });
    expect(c.expected).toMatch(/leasable area/);
  });

  it('a confirmed document value outranks a flyer', () => {
    const r = confirm(start(), 'occupancy');
    const m = mergeListing([flyer, ...listingSources(FIXTURE_DOCUMENT, preds, r)]);
    expect(m.fields.occupancyPct).toBe(92);
    expect(m.provenance.occupancyPct.sourceKind).toBe('document');
  });

  it('an unreviewed value never outranks a flyer, and the conflict names it unreviewed', () => {
    const m = mergeListing([flyer, ...listingSources(FIXTURE_DOCUMENT, preds, start(), { includeUnreviewed: true })]);
    expect(m.fields.occupancyPct).toBe(100);
    const c = m.conflicts.find((x) => x.field === 'occupancyPct');
    expect(isUnreviewedSourceName(c.dissenting[0].source)).toBe(true);
    expect(c.dissenting[0].kind).toBe('estimate');
  });
});
