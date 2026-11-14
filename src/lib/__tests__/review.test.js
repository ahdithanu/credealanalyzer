import { describe, it, expect } from 'vitest';
import {
  initialReview, confirm, reject, edit, reset, appliedValues, reviewSummary, parseEdit,
} from '../ingest/review';
import { FIELDS } from '../../extraction/schema';
import { fixturePredictions } from './fixtures/reviewFixtures';

/**
 * C4 review state. The property guarded throughout: nothing an extractor
 * said reaches a deal input until a person has confirmed or entered it.
 */

const fields = FIELDS.map((f) => ({ ...f, label: f.name, measured: true }));
const start = () => initialReview(fixturePredictions(), fields);

describe('initialReview', () => {
  it('puts every predicted field in pending with its extracted value', () => {
    const r = start();
    expect(Object.keys(r).sort()).toEqual(['address', 'occupancy', 'purchasePrice', 'squareFeet', 'yearBuilt']);
    for (const [name, e] of Object.entries(r)) {
      expect(e.status).toBe('pending');
      expect(e.value).toBe(fixturePredictions()[name].value);
      expect(e.original).toBe(fixturePredictions()[name].value);
      expect(e.origin).toBe('extracted');
    }
  });

  it('does not invent entries for fields the extractor abstained on', () => {
    const r = start();
    expect(r).not.toHaveProperty('capRate');
    expect(r).not.toHaveProperty('netOperatingIncome');
    expect(r).not.toHaveProperty('propertyType');
  });

  it('skips a prediction whose value is null rather than reviewing a null', () => {
    const r = initialReview({ capRate: { value: null, citation: null } }, fields);
    expect(r).toEqual({});
  });

  it('refuses a prediction for a field the schema does not define', () => {
    expect(() => initialReview({ madeUp: { value: 1 } }, fields)).toThrow(/unknown field/);
  });

  it('does not mutate the predictions it was given', () => {
    const p = fixturePredictions();
    const copy = JSON.parse(JSON.stringify(p));
    confirm(initialReview(p, fields), 'address');
    expect(p).toEqual(copy);
  });
});

describe('transitions', () => {
  it('confirm accepts the extracted value', () => {
    const r = confirm(start(), 'squareFeet');
    expect(r.squareFeet).toMatchObject({ status: 'confirmed', value: 12400 });
  });

  it('confirm after an edit restores the extracted value rather than confirming the edit', () => {
    const r = confirm(edit(start(), 'squareFeet', 11200), 'squareFeet');
    expect(r.squareFeet.value).toBe(12400);
  });

  it('reject keeps the original for the record but marks it rejected', () => {
    const r = reject(start(), 'purchasePrice', 'not in the document');
    expect(r.purchasePrice).toMatchObject({ status: 'rejected', value: 2400000, note: 'not in the document' });
  });

  it('edit records the original alongside the new value', () => {
    const r = edit(start(), 'squareFeet', 11200, 'rent roll total');
    expect(r.squareFeet).toMatchObject({ status: 'edited', value: 11200, original: 12400, origin: 'extracted' });
  });

  it('edit requires a value', () => {
    for (const blank of [null, undefined, '', '   ', NaN]) {
      expect(() => edit(start(), 'squareFeet', blank)).toThrow(/needs a value/);
    }
  });

  it('an abstained field can be entered manually, with no original', () => {
    const r = edit(start(), 'capRate', 6.25);
    expect(r.capRate).toEqual({ status: 'edited', value: 6.25, original: null, origin: 'manual' });
  });

  it('a manual entry cannot be confirmed or rejected, only reset', () => {
    const r = edit(start(), 'capRate', 6.25);
    expect(() => confirm(r, 'capRate')).toThrow(/entered manually/);
    expect(() => reject(r, 'capRate')).toThrow(/entered manually/);
    expect(reset(r, 'capRate')).not.toHaveProperty('capRate');
  });

  it('confirm and reject refuse a field nothing was extracted for', () => {
    expect(() => confirm(start(), 'capRate')).toThrow(/nothing was extracted/);
    expect(() => reject(start(), 'capRate')).toThrow(/nothing was extracted/);
  });

  it('reset returns an extracted field to pending with its original value', () => {
    const r = reset(edit(start(), 'squareFeet', 11200), 'squareFeet');
    expect(r.squareFeet).toEqual({ status: 'pending', value: 12400, original: 12400, origin: 'extracted' });
  });

  it('transitions do not mutate the review they were given', () => {
    const r = start();
    const copy = JSON.parse(JSON.stringify(r));
    confirm(r, 'address');
    reject(r, 'purchasePrice');
    edit(r, 'squareFeet', 1);
    edit(r, 'capRate', 1);
    expect(r).toEqual(copy);
  });
});

describe('appliedValues', () => {
  it('is empty until a human acts', () => {
    expect(appliedValues(start())).toEqual({});
  });

  it('returns only confirmed and edited values, never pending or rejected', () => {
    let r = start();
    r = confirm(r, 'address');
    r = edit(r, 'squareFeet', 11200);
    r = reject(r, 'purchasePrice');
    r = edit(r, 'capRate', 6.25);
    // yearBuilt and occupancy stay pending
    expect(appliedValues(r)).toEqual({
      address: '100 Fixture Way, Testville, OH',
      squareFeet: 11200,
      capRate: 6.25,
    });
  });

  it('ignores a hand-built entry whose status is not an applied one', () => {
    expect(appliedValues({ a: { status: 'pending', value: 1 }, b: { status: 'rejected', value: 2 }, c: { status: 'bogus', value: 3 } }))
      .toEqual({});
  });

  it('summary counts each status', () => {
    const r = reject(confirm(start(), 'address'), 'purchasePrice');
    expect(reviewSummary(r)).toEqual({ pending: 3, confirmed: 1, rejected: 1, edited: 0 });
  });
});

describe('parseEdit', () => {
  const f = (name) => fields.find((x) => x.name === name);

  it('reads separators and a currency sign on money', () => {
    expect(parseEdit(f('purchasePrice'), '$12,400,000')).toEqual({ value: 12400000 });
  });

  it('refuses text in a number field rather than coercing it', () => {
    expect(parseEdit(f('squareFeet'), 'about 12k')).toHaveProperty('error');
    expect(parseEdit(f('squareFeet'), '')).toHaveProperty('error');
  });

  it('refuses a fractional year', () => {
    expect(parseEdit(f('yearBuilt'), '1998.5')).toHaveProperty('error');
    expect(parseEdit(f('yearBuilt'), '1998')).toEqual({ value: 1998 });
  });

  it('holds an enum to its options', () => {
    expect(parseEdit(f('propertyType'), 'Retail')).toEqual({ value: 'retail' });
    expect(parseEdit(f('propertyType'), 'castle')).toHaveProperty('error');
  });
});
