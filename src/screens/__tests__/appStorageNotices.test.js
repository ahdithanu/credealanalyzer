/**
 * The storage banner, end to end through App.
 *
 * The "Browser storage is full" notice was dead code. storage.js's availability
 * probe round-tripped a setItem, so a browser whose quota was exhausted failed
 * the probe, every caller was told the facility was missing, and the user was
 * advised to check their private-browsing setting when the fix was to delete
 * some deals. This file renders the real App against each state and asserts the
 * reader is told the right thing — including that the quota branch is now
 * reachable at all.
 *
 * It lives here because src/screens/__tests__ is where this change's suite goes;
 * what it tests is App's own notice logic, not a screen.
 */

import React from 'react';
import App, { statusNotices } from '../../App';
import { saveDeals } from '../../lib/storage';
import { withScreen, text } from '../testing/renderScreen';

const quotaError = () => {
  const e = new Error('irrelevant prose');
  e.name = 'QuotaExceededError';
  return e;
};

beforeEach(() => window.localStorage.clear());
afterEach(() => jest.restoreAllMocks());

describe('statusNotices', () => {
  const only = (state) => statusNotices({ available: true, loadError: null, writeError: null, ...state });

  it('tells a user with a full store to delete deals, not to leave private browsing', () => {
    const [notice] = only({ writeError: 'quota', available: false });
    expect(notice).toMatch(/storage is full/i);
    expect(notice).toMatch(/delete deals/i);
    expect(notice).not.toMatch(/unavailable/i);
  });

  it('tells a user with no storage at all that nothing will persist', () => {
    const [notice] = only({ available: false });
    expect(notice).toMatch(/unavailable/i);
    expect(notice).not.toMatch(/full/i);
  });

  it('stops claiming work is unsaved once a write succeeds', () => {
    // A user who met a full quota and deleted deals to make room must not be
    // left reading a stale warning. The write path is the authority.
    expect(only({ writeError: null, loadError: 'quota', available: false })).toHaveLength(1);
    expect(only({ writeError: null, loadError: null, available: true })).toHaveLength(0);
  });

  it('keeps the corrupt-payload notice alongside a write failure', () => {
    // Two different facts about two different operations. Folding them into one
    // `error` field meant the next save's verdict overwrote the load's.
    const notices = only({ loadError: 'corrupt', writeError: 'quota', available: false });
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/set aside for recovery/i);
    expect(notices[1]).toMatch(/storage is full/i);
  });

  it('says nothing when persistence is working', () => {
    expect(only({})).toHaveLength(0);
  });
});

describe('App renders the notice a real browser state produces', () => {
  it('reaches the full-store notice when the store has content and refuses more', () => {
    // Seed real content first, so the store HAS quota and has run out of it.
    window.localStorage.setItem('anything', 'x');
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw quotaError(); });
    withScreen(<App />, (c) => {
      expect(text(c)).toMatch(/storage is full/i);
      expect(text(c)).toMatch(/delete deals/i);
    });
  });

  it('reaches the unavailable notice when an empty store refuses its first byte', () => {
    // Safari private browsing: the API is present, the quota is zero, and there
    // is nothing stored to delete.
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw quotaError(); });
    withScreen(<App />, (c) => {
      expect(text(c)).toMatch(/storage is unavailable/i);
      expect(text(c)).not.toMatch(/storage is full/i);
    });
  });

  it('shows no storage notice at all when persistence works', () => {
    withScreen(<App />, (c) => {
      expect(text(c)).not.toMatch(/storage is (full|unavailable)/i);
    });
  });

  it('does not lose the saved deals when the store is full', () => {
    // The read still works, so a full disk must not look like a first visit —
    // which App answers by seeding the sample portfolio over the user's work.
    saveDeals([{ id: 42, name: 'A deal the user typed', propertyType: 'multifamily', holdPeriod: 5 }]);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw quotaError(); });
    withScreen(<App />, (c) => {
      expect(text(c)).toContain('A deal the user typed');
    });
  });
});
