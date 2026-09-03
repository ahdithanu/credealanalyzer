import React from 'react';

/**
 * The IRR uniqueness qualification, in one place.
 *
 * runModel() solves each IRR by bisection and returns the FIRST bracketed root.
 * When a flow series changes sign more than once, several rates zero its NPV and
 * the one on screen is the one the bracket caught, not a return the deal
 * establishes. finance.js records the evidence on `returns.irrDiagnostics`,
 * where each of `.levered` and `.unlevered` carries `{signChanges, unique}` —
 * and until now nothing in the app read it, so an indicative rate and a settled
 * one rendered identically.
 *
 * THREE states, and only one of them says anything:
 *
 *   unique === true   The series turns over at most once, so the rate is the
 *                     rate. Nothing is added; a caveat on a settled number is
 *                     noise that teaches readers to ignore the mark.
 *   unique === null   No flow series was built — an incomplete model — so
 *                     uniqueness was never established EITHER WAY. Rendering a
 *                     qualification here would invent a doubt the model does not
 *                     claim, so nothing is rendered.
 *   unique === false  Several rates satisfy the equation. Qualify the figure.
 *
 * The qualification is a note on a number, not an error state: the IRR is still
 * shown, at full precision, in its usual place. It is A rate that solves the
 * equation; what is missing is the proof that it is the only one. The model
 * claims nothing more than that, so neither does this.
 */

/** The footnote mark. Deliberately quiet — this qualifies, it does not warn. */
export const IRR_MARK = '*';

/**
 * @param {Object|null|undefined} diagnostics `model.returns.irrDiagnostics`
 * @param {'levered'|'unlevered'} series
 * @returns {{mark:string, text:string, signChanges:number|null}|null}
 *          null when there is nothing to say — see the three states above.
 */
export function irrQualification(diagnostics, series) {
  const d = diagnostics && diagnostics[series];
  // Strictly `=== false`. `!d.unique` would fire on the null state too, which is
  // the one case where the model has established nothing at all.
  if (!d || d.unique !== false) return null;
  const signChanges = Number.isFinite(d.signChanges) ? d.signChanges : null;
  const turns = signChanges === null
    ? 'changes sign more than once'
    : `changes sign ${signChanges} times`;
  return {
    mark: IRR_MARK,
    signChanges,
    text:
      `The ${series} cash flow ${turns}, so more than one rate satisfies this IRR ` +
      'equation. The figure shown is one of them, chosen by the solver’s bracket; ' +
      'uniqueness is not established. Read it alongside the equity multiple.',
  };
}

/** The same text, for a screen that footnotes the mark once rather than inline. */
export const IRR_FOOTNOTE =
  `${IRR_MARK} More than one rate satisfies this IRR equation — the cash flow ` +
  'changes sign more than once — so the figure shown is one solution rather than ' +
  'an established unique return.';

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
