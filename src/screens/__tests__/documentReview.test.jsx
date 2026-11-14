/**
 * The document review screen, against FIXTURE documents (see
 * src/lib/__tests__/fixtures/reviewFixtures.js; none of it is a real filing).
 *
 * What is guarded: every field is shown in exactly one honest state, an
 * ungrounded answer is never shown as if it were cited, an abstention is
 * never a blank, and nothing reaches onApply without a human confirming it.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { vi } from 'vitest';

import DocumentReview, { productFields, resolveCitation } from '../DocumentReview';
import App from '../../App';
import { FIELD_NAMES } from '../../extraction/schema';
import {
  renderScreen, withScreen, click, setValue, buttonsByText, text, assertNoImpossibleNumbers,
} from '../testing/renderScreen';
import {
  FIXTURE_DOCUMENT, FIXTURE_SCANNED, FIXTURE_DRAFT_FIELD, fixturePredictions,
} from '../../lib/__tests__/fixtures/reviewFixtures';

const row = (c, name) => c.querySelector(`[data-field="${name}"]`);
const btn = (el, re) => buttonsByText(el, re)[0];
const applyButton = (c) => btn(c, /^Apply \d+ reviewed value/);

const render = (props = {}) => renderScreen(
  <DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} {...props} />,
);

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('fields', () => {
  it('reads C3 through the fallback: the eight measured fields come first', () => {
    const f = productFields();
    expect(f.slice(0, 8).map((x) => x.name)).toEqual(FIELD_NAMES);
    expect(f.slice(0, 8).every((x) => x.measured === true && typeof x.label === 'string')).toBe(true);
  });

  it('shows a row for every field, answered or not', () => {
    withScreen(<DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} />, (c) => {
      for (const name of FIELD_NAMES) expect(row(c, name)).not.toBeNull();
      assertNoImpossibleNumbers(c, 'DocumentReview');
    });
  });
});

describe('citation states', () => {
  it('a grounded answer shows the cited span highlighted in context, with its page', () => {
    withScreen(<DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} />, (c) => {
      const r = row(c, 'squareFeet');
      expect(r.querySelector('mark').textContent).toBe('12,400 square feet');
      const quote = r.querySelector('[data-testid="citation"]').textContent;
      expect(quote).toMatch(/Page 1/);
      expect(quote).toMatch(/100 Fixture Way/);          // context before the span
      expect(quote).toMatch(/of leasable area/);         // context after it
      expect(r.querySelector('[data-testid="ungrounded"]')).toBeNull();
      expect(r.textContent).toMatch(/confidence 80%/);
      expect(row(c, 'occupancy').querySelector('[data-testid="citation"]').textContent).toMatch(/Page 2/);
    });
  });

  it('an ungrounded answer is shown with a warning, not hidden and not highlighted', () => {
    withScreen(<DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} />, (c) => {
      const r = row(c, 'purchasePrice');
      expect(r.querySelector('[data-testid="extracted"]').textContent).toBe('$2,400,000');
      expect(r.querySelector('[data-testid="ungrounded"]').textContent).toMatch(/quote for this value was not found in the document/);
      expect(r.querySelector('mark')).toBeNull();
    });
  });

  it('a citation outside the page text is treated as ungrounded', () => {
    withScreen(<DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} />, (c) => {
      const r = row(c, 'yearBuilt');
      expect(r.querySelector('[data-testid="ungrounded"]').textContent).toMatch(/outside the document text/);
      expect(r.querySelector('mark')).toBeNull();
      expect(r.textContent).toMatch(/confidence n\/a/);
    });
    expect(resolveCitation(FIXTURE_DOCUMENT, { page: 3, start: 0, end: 1 }).ok).toBe(false);
    expect(resolveCitation(FIXTURE_DOCUMENT, { page: 1, start: 5, end: 5 }).ok).toBe(false);
    expect(resolveCitation(FIXTURE_DOCUMENT, { page: 1, start: 0, end: 7 }).span).toBe('FIXTURE');
  });

  it('an abstention reads "not stated in the document", not a blank', () => {
    withScreen(<DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} />, (c) => {
      for (const name of ['propertyType', 'netOperatingIncome', 'capRate']) {
        const r = row(c, name);
        expect(r.querySelector('[data-testid="abstained"]').textContent).toBe('Not stated in the document.');
        expect(btn(r, /^Confirm$/)).toBeUndefined();
        expect(btn(r, /Enter manually/)).toBeTruthy();
      }
    });
  });
});

describe('unmeasured fields', () => {
  it('a field with no eval carries a visible marker; measured ones do not', () => {
    const fields = [...productFields().slice(0, 8), FIXTURE_DRAFT_FIELD];
    withScreen(<DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} fields={fields} />, (c) => {
      expect(row(c, 'askingRent').querySelector('[data-testid="unmeasured"]').textContent).toBe('unmeasured: no eval');
      expect(row(c, 'squareFeet').querySelector('[data-testid="unmeasured"]')).toBeNull();
    });
  });
});

describe('conflicts', () => {
  const assessor = { sourceKind: 'public', sourceName: 'fixture assessor', fields: { buildingSize: 11200 } };

  it('shows each source and its value, marking the unreviewed one', () => {
    withScreen(
      <DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} otherSources={[assessor]} />,
      (c) => {
        const conflict = row(c, 'squareFeet').querySelector('[data-testid="conflict"]');
        expect(conflict).not.toBeNull();
        expect(conflict.textContent).toMatch(/11,200 SF from fixture assessor \(public\) leads/);
        expect(conflict.textContent).toMatch(/12,400 SF from fixture-offering-memo\.pdf \(unreviewed extraction\) \(estimate, not yet reviewed\)/);
        expect(row(c, 'address').querySelector('[data-testid="conflict"]')).toBeNull();
      },
    );
  });

  it('after confirm, the conflict names the document tier', () => {
    withScreen(
      <DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} otherSources={[assessor]} />,
      (c) => {
        click(btn(row(c, 'squareFeet'), /^Confirm$/));
        const conflict = row(c, 'squareFeet').querySelector('[data-testid="conflict"]');
        expect(conflict.textContent).toMatch(/12,400 SF from fixture-offering-memo\.pdf \(document\)/);
        expect(conflict.textContent).not.toMatch(/not yet reviewed/);
      },
    );
  });

  it('shows no conflict section without other sources', () => {
    withScreen(<DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} />, (c) => {
      expect(c.querySelector('[data-testid="conflict"]')).toBeNull();
    });
  });
});

describe('no text layer', () => {
  it('says extraction is not possible instead of rendering an empty form', () => {
    withScreen(<DocumentReview document={FIXTURE_SCANNED} predictions={{}} />, (c) => {
      expect(c.querySelector('[data-testid="no-text-layer"]').textContent).toMatch(/scanned PDF.*OCR is not supported/);
      expect(c.querySelector('[data-field]')).toBeNull();
      expect(applyButton(c)).toBeUndefined();
    });
  });
});

describe('nothing applies without a human', () => {
  it('rendering and confirming alone never call onApply', () => {
    const onApply = vi.fn();
    const { container: c } = render({ onApply });
    expect(applyButton(c).disabled).toBe(true);
    click(btn(row(c, 'squareFeet'), /^Confirm$/));
    expect(onApply).not.toHaveBeenCalled();
    expect(applyButton(c).disabled).toBe(false);
  });

  it('apply hands over only confirmed and edited values', () => {
    const onApply = vi.fn();
    const onReviewChange = vi.fn();
    const { container: c } = render({ onApply, onReviewChange });

    click(btn(row(c, 'squareFeet'), /^Confirm$/));
    click(btn(row(c, 'purchasePrice'), /^Reject$/));
    // abstained field, entered by hand
    click(btn(row(c, 'capRate'), /Enter manually/));
    setValue(row(c, 'capRate').querySelector('input'), '6.25');
    click(btn(row(c, 'capRate'), /Save value/));
    // yearBuilt, address, occupancy left pending

    expect(onReviewChange).toHaveBeenCalledTimes(3);
    expect(row(c, 'capRate').textContent).toMatch(/entered manually, no citation/);
    click(applyButton(c));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toEqual({ squareFeet: 12400, capRate: 6.25 });
  });

  it('an unreadable edit is refused, not saved as a value', () => {
    const onApply = vi.fn();
    const { container: c } = render({ onApply });
    click(btn(row(c, 'squareFeet'), /^Edit$/));
    setValue(row(c, 'squareFeet').querySelector('input'), 'about 12k');
    click(btn(row(c, 'squareFeet'), /Save value/));
    expect(row(c, 'squareFeet').querySelector('[role="alert"]').textContent).toMatch(/Not a number/);
    expect(row(c, 'squareFeet').querySelector('[data-testid="status"]').textContent).toBe('pending');
    expect(applyButton(c).disabled).toBe(true);
  });

  it('undo returns a confirmed field to pending and it stops applying', () => {
    const { container: c } = render({ onApply: vi.fn() });
    click(btn(row(c, 'address'), /^Confirm$/));
    click(btn(row(c, 'address'), /^Undo$/));
    expect(row(c, 'address').querySelector('[data-testid="status"]').textContent).toBe('pending');
    expect(applyButton(c).disabled).toBe(true);
  });
});

describe('review state belongs to one document', () => {
  // A root that can be re-rendered with new props, as App would when its
  // documentReview prop changes. renderScreen mounts once, so this test owns
  // its root.
  const mount = () => {
    window.IS_REACT_ACT_ENVIRONMENT = true;
    const act = React.act;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    return {
      container,
      act,
      render: (el) => act(() => { root.render(el); }),
      unmount: () => act(() => { root.unmount(); }),
    };
  };

  it('swapping to another document drops decisions made on the first', () => {
    const onApply = vi.fn();
    const m = mount();
    try {
      m.render(<DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} onApply={onApply} />);
      m.act(() => { btn(row(m.container, 'squareFeet'), /^Confirm$/).click(); });
      expect(row(m.container, 'squareFeet').querySelector('[data-testid="status"]').textContent).toBe('confirmed');

      const other = { ...FIXTURE_DOCUMENT, id: 'fixture-other', filename: 'fixture-other.pdf' };
      m.render(<DocumentReview document={other} predictions={{}} onApply={onApply} />);
      const r = row(m.container, 'squareFeet');
      expect(r.querySelector('[data-testid="abstained"]')).not.toBeNull();
      expect(r.querySelector('[data-testid="status"]').textContent).toBe('no value');
      expect(applyButton(m.container).textContent).toMatch(/^Apply 0 reviewed values/);
      expect(applyButton(m.container).disabled).toBe(true);
      m.act(() => { applyButton(m.container).click(); });
      expect(onApply).not.toHaveBeenCalled();
    } finally { m.unmount(); }
  });

  it('a new extraction of the same document starts its review afresh', () => {
    const m = mount();
    try {
      m.render(<DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} onApply={vi.fn()} />);
      m.act(() => { btn(row(m.container, 'squareFeet'), /^Confirm$/).click(); });
      const rerun = fixturePredictions();
      rerun.squareFeet = { ...rerun.squareFeet, value: 12500 };
      m.render(<DocumentReview document={FIXTURE_DOCUMENT} predictions={rerun} onApply={vi.fn()} />);
      expect(row(m.container, 'squareFeet').querySelector('[data-testid="status"]').textContent).toBe('pending');
      expect(applyButton(m.container).disabled).toBe(true);
    } finally { m.unmount(); }
  });

  it('re-rendering with the same document and predictions keeps the review', () => {
    const m = mount();
    try {
      m.render(<DocumentReview document={FIXTURE_DOCUMENT} predictions={fixturePredictions()} onApply={vi.fn()} />);
      m.act(() => { btn(row(m.container, 'squareFeet'), /^Confirm$/).click(); });
      // equal content, new object identities, as a parent re-render produces
      m.render(<DocumentReview document={{ ...FIXTURE_DOCUMENT }} predictions={fixturePredictions()} onApply={vi.fn()} />);
      expect(row(m.container, 'squareFeet').querySelector('[data-testid="status"]').textContent).toBe('confirmed');
    } finally { m.unmount(); }
  });
});

describe('unknown fields', () => {
  it('an extraction naming an undefined field gets a notice, not a partial form', () => {
    const predictions = { ...fixturePredictions(), notAField: { value: 1, quality: 'sourced', confidence: null, citation: null } };
    withScreen(<DocumentReview document={FIXTURE_DOCUMENT} predictions={predictions} onApply={vi.fn()} />, (c) => {
      expect(c.querySelector('[data-testid="unknown-fields"]').textContent).toMatch(/notAField/);
      expect(c.querySelector('[data-field]')).toBeNull();
      expect(applyButton(c)).toBeUndefined();
    });
  });
});

describe('App wiring', () => {
  beforeEach(() => window.localStorage.clear());

  it('without a document, App offers no document review at all', () => {
    withScreen(<App />, (c) => {
      expect(c.querySelector('[title="Document review"]')).toBeNull();
      expect(text(c)).not.toMatch(/fixture-offering-memo/);
    });
  });

  it('with a document, the rail reaches the review screen', () => {
    withScreen(<App documentReview={{ document: FIXTURE_DOCUMENT, predictions: fixturePredictions() }} />, (c) => {
      click(c.querySelector('[title="Document review"]'));
      expect(c.querySelector('h1').textContent).toBe('Document review');
      expect(row(c, 'squareFeet')).not.toBeNull();
    });
  });
});
