import React from 'react';

/**
 * The IRR uniqueness qualification, in one place.
 *
 * finance.js solves every IRR by bisection and returns the FIRST bracketed root.
 * It publishes the evidence on `returns.irrDiagnostics`, where each of
 * `.levered` and `.unlevered` carries `{signChanges, uniquenessGuaranteed}` —
 * and until now nothing in the app read it, so a rate that had been PROVED to be
 * the deal's return and one that merely had not been disproved rendered in
 * identical type.
 *
 * READ THE FIELD NAME AS WRITTEN. It is `uniquenessGuaranteed`, not `unique`,
 * and finance.js says why at length: Descartes' rule bounds the root count from
 * ABOVE and says nothing from below. One sign change proves at most one root, so
 * `true` is a guarantee. Two or more proves nothing either way. A surface that
 * reads `false` as "this deal has several returns" states a falsehood about most
 * deals that trip it — every sample deal that does has exactly one real IRR — so
 * the wording below withdraws a guarantee and claims nothing beyond that.
 *
 * THREE states, and only one of them says anything:
 *
 *   true   Proved: one sign change, so the figure IS the return. Nothing is
 *          added; a caveat on a settled number teaches readers to ignore marks.
 *   null   No flow series was built — an incomplete model — so nothing was
 *          established EITHER WAY. Rendering a qualification here would invent a
 *          doubt the model does not claim, so nothing is rendered.
 *   false  The guarantee is withdrawn. Qualify the figure, quietly.
 *
 * This is a note on a number, not an error state. The IRR stays on screen at
 * full precision in its usual place; what is missing is the proof, and the model
 * claims nothing more than that, so neither does this.
 */

/** The footnote mark. Deliberately quiet — this qualifies, it does not warn. */
export const IRR_MARK = '*';

/** The phrase every surface uses, so the mark means one thing across the app. */
export const IRR_SHORT = 'uniqueness not established';

/**
 * @param {Object|null|undefined} diagnostics `model.returns.irrDiagnostics`
 * @param {'levered'|'unlevered'} series
 * @returns {{mark:string, text:string, signChanges:number|null}|null}
 *          null when there is nothing to say — see the three states above.
 */
export function irrQualification(diagnostics, series) {
  const d = diagnostics && diagnostics[series];
  // Strictly `=== false`. `!d.uniquenessGuaranteed` would fire on the null state
  // too, which is the one case where the model has established nothing at all.
  if (!d || d.uniquenessGuaranteed !== false) return null;
  const signChanges = Number.isFinite(d.signChanges) ? d.signChanges : null;
  const turns = signChanges === null
    ? 'changes sign more than once'
    : `changes sign ${signChanges} times`;
  return {
    mark: IRR_MARK,
    signChanges,
    text:
      `The ${series} cash flow ${turns}, so ${IRR_SHORT}: the sign-change bound ` +
      'rules out more than one rate only when the flow turns over once. The figure ' +
      'is a rate that zeroes the NPV and may well be the only one — it has not been ' +
      'proved to be. Read it alongside the equity multiple.',
  };
}

/** The same qualification, for a screen that footnotes the mark once. */
export const IRR_FOOTNOTE =
  `${IRR_MARK} The cash flow behind this figure turns over more than once, so ` +
  `${IRR_SHORT}. It is a rate that zeroes the NPV; it has not been proved to be ` +
  'the only one. This withdraws a guarantee rather than reporting a fault.';

/**
 * The mark itself. Renders nothing at all when there is no qualification, so a
 * caller can drop it beside any IRR unconditionally.
 */
export function IrrMark({ qualification }) {
  if (!qualification) return null;
  return (
    <span className="dim2" title={qualification.text} style={{ marginLeft: '2px' }}>
      {qualification.mark}
    </span>
  );
}

/** The mark as a plain string, for a slot that is typed as text rather than nodes. */
export function irrMarkText(qualification) {
  return qualification ? ` ${qualification.mark}` : '';
}
