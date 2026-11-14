import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as schema from '../schema';
import { promptSha } from '../modelExtractor';
import { sha256Hex } from '../sha256';

const {
  FIELDS, COMPARATORS, DRAFT_COMPARATORS, PRODUCT_COMPARATORS, DRAFT_FIELDS, PRODUCT_FIELDS,
  PRODUCT_FIELD_NAMES, productFieldByName, productValuesAgree, valuesAgree,
} = schema;

// Values computed on the base commit 05c7411, before any product field was
// added. If one of these moves, the eval's recorded numbers no longer describe
// the code: revert the change, do not update the constant.
const BASE_FIELDS_JSON = '[{"name":"address","kind":"text","required":true},{"name":"propertyType","kind":"enum","required":true,"options":["office","retail","industrial","multifamily","mixed-use","other"]},{"name":"squareFeet","kind":"area","required":true},{"name":"yearBuilt","kind":"year","required":false},{"name":"purchasePrice","kind":"money","required":false},{"name":"netOperatingIncome","kind":"money","required":false},{"name":"capRate","kind":"percent","required":false},{"name":"occupancy","kind":"percent","required":false}]';
const BASE_FIELDS_SHA = 'cf8b7d55d157e7e64312f60c2c00feaa4b3fbe934df1236e0760c6bdb52afd72';
const BASE_MODEL_PROMPT_SHA = 'e632f2b97fa72096f0266a835bdb632a65f5f050e127abfef10003bbb6a83719';
const BASE_MODEL_EXTRACTOR_FILE_SHA = '98ebefc62e900f69225ab9e9b2e1e8b000a997f9374ad8d76dae2446419cda81';

describe('the eval is untouched', () => {
  it('FIELDS is byte for byte what it was on the base commit', () => {
    expect(JSON.stringify(FIELDS)).toBe(BASE_FIELDS_JSON);
    expect(createHash('sha256').update(JSON.stringify(FIELDS)).digest('hex')).toBe(BASE_FIELDS_SHA);
  });

  it("modelExtractor's prompt hash and source are unchanged", () => {
    expect(promptSha()).toBe(BASE_MODEL_PROMPT_SHA);
    // vitest runs these under jsdom, where import.meta.url is not a file URL;
    // the repo root is the working directory vitest is run from.
    const src = readFileSync(path.resolve(process.cwd(), 'src/extraction/modelExtractor.js'));
    expect(createHash('sha256').update(src).digest('hex')).toBe(BASE_MODEL_EXTRACTOR_FILE_SHA);
  });

  it('COMPARATORS holds the six eval kinds and nothing else', () => {
    expect(Object.keys(COMPARATORS).sort()).toEqual(['area', 'enum', 'money', 'percent', 'text', 'year']);
  });

  it('valuesAgree still refuses a product-only field', () => {
    expect(() => valuesAgree('units', 1, 1)).toThrow(/unknown field/);
  });
});

describe('PRODUCT_FIELDS (contract C3)', () => {
  it('starts with FIELDS, in order, unchanged, marked measured', () => {
    const head = PRODUCT_FIELDS.slice(0, FIELDS.length);
    expect(FIELDS).toHaveLength(8);
    head.forEach((p, i) => {
      const { label, unit, measured, ...rest } = p;
      expect(rest).toEqual(FIELDS[i]);
      expect(measured).toBe(true);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    });
  });

  it('then the draft fields, every one unmeasured', () => {
    expect(PRODUCT_FIELDS.slice(FIELDS.length)).toEqual(DRAFT_FIELDS);
    expect(DRAFT_FIELDS.length).toBeGreaterThan(0);
    for (const f of DRAFT_FIELDS) expect(f.measured).toBe(false);
  });

  it('has the C3 shape, unique names, and a comparator for every kind', () => {
    expect(new Set(PRODUCT_FIELD_NAMES).size).toBe(PRODUCT_FIELDS.length);
    for (const f of PRODUCT_FIELDS) {
      expect(typeof f.name).toBe('string');
      expect(typeof f.label).toBe('string');
      expect(typeof f.measured).toBe('boolean');
      expect(typeof PRODUCT_COMPARATORS[f.kind]).toBe('function');
      if (f.kind === 'enum') expect(Array.isArray(f.options) && f.options.length > 0).toBe(true);
      if (f.unit !== undefined) expect(typeof f.unit).toBe('string');
    }
  });

  it('is readable through the fallback consumers use before C3 lands', () => {
    const fields = schema.PRODUCT_FIELDS ?? schema.FIELDS.map((f) => ({ ...f, label: f.name, measured: true }));
    expect(fields).toBe(PRODUCT_FIELDS);
  });

  it('covers the underwriting inputs the deal model takes', () => {
    for (const n of ['units', 'grossPotentialRent', 'operatingExpenses', 'realEstateTaxes', 'askingPrice',
      'loanAmount', 'interestRate', 'amortizationYears', 'loanTermYears', 'weightedAverageLeaseTerm']) {
      expect(PRODUCT_FIELD_NAMES).toContain(n);
    }
  });

  it('looks fields up and refuses unknown ones', () => {
    expect(productFieldByName('units').kind).toBe('count');
    expect(() => productFieldByName('nope')).toThrow(/unknown product field/);
  });
});

describe('draft comparators', () => {
  it('count: exact integers only', () => {
    const { count } = DRAFT_COMPARATORS;
    expect(count(240, 240)).toBe(true);
    expect(count(241, 240)).toBe(false);
    expect(count(240.0001, 240)).toBe(false);
    expect(count('240', 240)).toBe(false);
    expect(count(null, 240)).toBe(false);
  });

  it('rate: half a basis point, in points, never a fraction', () => {
    const { rate } = DRAFT_COMPARATORS;
    expect(rate(5.13, 5.125)).toBe(true);
    expect(rate(5.125, 5.125)).toBe(true);
    expect(rate(5.135, 5.125)).toBe(false);
    expect(rate(5.35, 5.25)).toBe(false);
    expect(rate(0.0525, 5.25)).toBe(false);
    expect(rate(NaN, 5.25)).toBe(false);
  });

  it('duration: half a tenth of a year, months are not years', () => {
    const { duration } = DRAFT_COMPARATORS;
    expect(duration(5.42, 5.4)).toBe(true);
    expect(duration(5.45, 5.4)).toBe(true);
    expect(duration(5.5, 5.4)).toBe(false);
    expect(duration(120, 10)).toBe(false);
    expect(duration(undefined, 10)).toBe(false);
  });

  it('productValuesAgree routes eval kinds to the eval comparators and draft kinds to theirs', () => {
    expect(productValuesAgree('squareFeet', 100040, 100000)).toBe(true);
    expect(productValuesAgree('askingPrice', 12_400_000, 12_400_000)).toBe(true);
    expect(productValuesAgree('askingPrice', 12_500_000, 12_400_000)).toBe(false);
    expect(productValuesAgree('interestRate', 6.1, 6.0)).toBe(false);
    expect(productValuesAgree('units', 80, 80)).toBe(true);
    expect(productValuesAgree('operatingExpensesIncludeTaxes', 'Includes-Taxes', 'includes-taxes')).toBe(true);
  });
});

describe('sha256Hex', () => {
  it('matches node:crypto on standard vectors and on long, non-ASCII input', () => {
    const node = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const s of ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '— é 漢字 '.repeat(1000), BASE_FIELDS_JSON]) {
      expect(sha256Hex(s)).toBe(node(s));
    }
  });
});
