/**
 * The screen suite's render harness and its one shared assertion.
 *
 * React Testing Library is not a dependency of this project, and adding one is
 * not part of the change these tests belong to, so this is the small piece of it
 * the suite actually needs: mount a component into a detached node inside act(),
 * hand back the container, tear it down.
 *
 * It lives OUTSIDE `__tests__/` on purpose — CRA's jest testMatch collects every
 * file under a `__tests__` directory as a suite, and a helper module collected
 * that way fails with "must contain at least one test".
 *
 * For the same reason it uses no jest globals: files outside `__tests__` do not
 * get the jest env from eslint-config-react-app, and `expect` would be a
 * no-undef error at build time. `assertNoImpossibleNumbers` therefore throws its
 * own Error, which jest reports as a failure exactly as an expect() would.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import * as testUtils from 'react-dom/test-utils';

// React 18.3 moved act onto the React package and deprecated the test-utils
// export, which warns on every call. Prefer the new home; fall back so the
// harness does not depend on which of the two the installed React exposes.
const act = typeof React.act === 'function' ? React.act : testUtils.act;

/**
 * The strings that must never reach a user.
 *
 * Every one of them is the visible end of a defect this project has actually
 * shipped: a division by an unknown, a template literal over an absent field, an
 * IRR solver that overflowed, a percentage of nothing. They are checked against
 * innerHTML rather than textContent so that a NaN inside an attribute — an SVG
 * path `d`, a `style="width: NaN%"`, a `title` — is caught too. Those never
 * appear as text and are exactly where the arithmetic bugs hide.
 */
export const IMPOSSIBLE_NUMBERS = ['NaN', 'undefined', 'Infinity', '$NaN', '-$NaN', 'NaN%'];

/** Mount `element`, returning `{ container, unmount }`. */
export function renderScreen(element) {
  // React 18 requires this flag before it will accept act().
  window.IS_REACT_ACT_ENVIRONMENT = true;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(React.createElement(React.StrictMode, null, element)); });

  return {
    container,
    unmount() {
      act(() => { root.unmount(); });
      container.remove();
    },
  };
}

/** Render, run `body(container)`, and always unmount. */
export function withScreen(element, body) {
  const { container, unmount } = renderScreen(element);
  try {
    return body(container);
  } finally {
    unmount();
  }
}

/**
 * THE assertion. Run on every screen against every case.
 *
 * An underwriting screen that prints NaN, undefined or Infinity has stopped
 * being wrong about a number and started being wrong about arithmetic, and every
 * screen-level defect this project has found was of that shape. A missing figure
 * has exactly one correct rendering here and it is `n/a` (format.js NA) — never
 * a zero, never a blank, and never the JavaScript spelling of the absence.
 *
 * @param {Element} container rendered output
 * @param {string}  label     what was rendered, for the failure message
 */
export function assertNoImpossibleNumbers(container, label) {
  const html = container.innerHTML;
  const hits = IMPOSSIBLE_NUMBERS.filter((token) => html.includes(token));
  if (hits.length === 0) return;

  // Show where, not just that: a bare "contains NaN" on a 200KB table is
  // unactionable. Each hit is reported with the markup either side of it.
  const excerpts = hits.map((token) => {
    const at = html.indexOf(token);
    return `  ${token} at ${at}: …${html.slice(Math.max(0, at - 120), at + 120)}…`;
  });
  throw new Error(
    `${label}: rendered output contains ${hits.join(', ')}. ` +
    'A figure the model could not compute must render as an explicit absence (n/a), ' +
    `never as the JavaScript spelling of one.\n${excerpts.join('\n')}`,
  );
}

/** Click, inside act(), the way a user would. */
export function click(el) {
  if (!el) throw new Error('click: no element');
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/**
 * Set a form control's value the way React's synthetic onChange expects.
 *
 * Assigning `el.value` directly does not notify React 18, because it caches the
 * previous value on the node; the native setter has to be called explicitly.
 */
export function setValue(el, value) {
  if (!el) throw new Error('setValue: no element');
  const proto = el instanceof window.HTMLSelectElement
    ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  act(() => {
    setter.call(el, String(value));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Every button whose visible text matches. */
export function buttonsByText(container, pattern) {
  return [...container.querySelectorAll('button')].filter((b) => pattern.test(b.textContent));
}

/** Visible text only, for assertions about what a reader actually sees. */
export function text(container) {
  return container.textContent || '';
}
