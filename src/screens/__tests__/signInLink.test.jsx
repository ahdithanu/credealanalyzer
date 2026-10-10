/**
 * The sign-in-link half of the portal.
 *
 * The property worth guarding here is not that the button works. It is that
 * this screen CANNOT be used to find out whether an address can sign in.
 * /auth/magic/start answers identically for a real address, an unknown one, a
 * firm that never enabled the method and a suspended firm, precisely so it is
 * not a customer list — and a UI that rendered "we don't know that address"
 * would hand back from the client exactly what the server refuses to leak.
 *
 * So most of what follows asserts SAMENESS, which is an unusual thing to test
 * and the whole point of the endpoint.
 */

import React from 'react';
import { vi } from 'vitest';

import SignIn from '../SignIn';
import { api } from '../../lib/api';
import {
  renderScreen, clickAsync, setValue, text, buttonsByText,
} from '../testing/renderScreen';

function fill(container, address) {
  setValue(container.querySelector('#email'), address);
}
const linkButton = (c) => buttonsByText(c, /Email me a sign-in link|Sending/)[0];

afterEach(() => { vi.restoreAllMocks(); });

test('a sign-in link can be requested for a valid address', async () => {
  const spy = vi.spyOn(api, 'requestSignInLink').mockResolvedValue({ sent: true });
  const { container } = renderScreen(<SignIn status="ok" />);

  fill(container, 'analyst@firmx.com');
  await clickAsync(linkButton(container));

  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][0].email).toBe('analyst@firmx.com');
  expect(text(container)).toMatch(/a link is on its way/i);
});

test('the confirmation is identical for an address the server refuses', async () => {
  // The server answered 202 either way; the client has nothing to distinguish
  // and must not invent anything.
  vi.spyOn(api, 'requestSignInLink').mockResolvedValue({ sent: true });

  const a = renderScreen(<SignIn status="ok" />);
  fill(a.container, 'analyst@firmx.com');
  await clickAsync(linkButton(a.container));

  const b = renderScreen(<SignIn status="ok" />);
  fill(b.container, 'nobody@nowhere.example');
  await clickAsync(linkButton(b.container));

  const confirmation = (c) => c.querySelector('.signin-note').textContent.trim();
  expect(confirmation(a.container)).toBe(confirmation(b.container));
});

test('the confirmation never names the address or the firm', async () => {
  // Echoing the address back is how a screenshot of this page becomes
  // evidence that an address is valid.
  vi.spyOn(api, 'requestSignInLink').mockResolvedValue({ sent: true });
  const { container } = renderScreen(<SignIn status="ok" />);
  fill(container, 'analyst@firmx.com');
  await clickAsync(linkButton(container));

  const note = container.querySelector('.signin-note').textContent;
  expect(note).not.toMatch(/analyst@firmx\.com/);
  expect(note).not.toMatch(/firmx/i);
});

test('a transport failure says so, rather than claiming a link was sent', async () => {
  // The one honest distinction available: the server said nothing at all.
  vi.spyOn(api, 'requestSignInLink').mockRejectedValue(new Error('offline'));
  const { container } = renderScreen(<SignIn status="ok" />);
  fill(container, 'analyst@firmx.com');
  await clickAsync(linkButton(container));

  expect(container.querySelector('.signin-note')).toBe(null);
  expect(text(container)).toMatch(/could not reach the service/i);
});

test('editing the address clears a confirmation that no longer applies', async () => {
  // Otherwise the page goes on claiming a link was sent to an address that is
  // no longer in the box.
  vi.spyOn(api, 'requestSignInLink').mockResolvedValue({ sent: true });
  const { container } = renderScreen(<SignIn status="ok" />);
  fill(container, 'analyst@firmx.com');
  await clickAsync(linkButton(container));
  expect(container.querySelector('.signin-note')).not.toBe(null);

  fill(container, 'someone.else@firmx.com');
  expect(container.querySelector('.signin-note')).toBe(null);
});

test('the button is offered to everyone, not gated on the address', async () => {
  // Showing it per-firm would require asking the server which firms allow it,
  // which is the question the server exists not to answer.
  const { container } = renderScreen(<SignIn status="ok" />);
  expect(linkButton(container)).not.toBe(undefined);
});

test('no link is requested for an address that is not one', async () => {
  const spy = vi.spyOn(api, 'requestSignInLink').mockResolvedValue({ sent: true });
  const { container } = renderScreen(<SignIn status="ok" />);
  fill(container, 'not-an-email');
  await clickAsync(linkButton(container));
  expect(spy).not.toHaveBeenCalled();
});

test('nothing is requested while the service is unreachable', async () => {
  const spy = vi.spyOn(api, 'requestSignInLink').mockResolvedValue({ sent: true });
  const { container } = renderScreen(<SignIn status="unreachable" />);
  fill(container, 'analyst@firmx.com');
  await clickAsync(linkButton(container));
  expect(spy).not.toHaveBeenCalled();
});

test('an expired link bounces back with a message that does not say which half failed', () => {
  // link_invalid covers "never existed", "already used" and "expired" — one
  // message, matching the single code the server returns.
  const url = new URL(window.location.href);
  url.searchParams.set('error', 'link_invalid');
  window.history.replaceState({}, '', url);
  try {
    const { container } = renderScreen(<SignIn status="ok" />);
    const msg = container.querySelector('.signin-error').textContent;
    expect(msg).toMatch(/expired or was already used/i);
    expect(msg).not.toMatch(/expired only|already used only|no such/i);
  } finally {
    url.searchParams.delete('error');
    window.history.replaceState({}, '', url);
  }
});

test('an unrecognised error code is not echoed into the page', () => {
  // Reflecting an arbitrary query parameter is how a phishing link puts its
  // own words on our domain.
  const url = new URL(window.location.href);
  url.searchParams.set('error', 'Call 555-0100 to restore your account');
  window.history.replaceState({}, '', url);
  try {
    const { container } = renderScreen(<SignIn status="ok" />);
    expect(text(container)).not.toMatch(/555-0100/);
    expect(text(container)).toMatch(/Sign-in did not complete/i);
  } finally {
    url.searchParams.delete('error');
    window.history.replaceState({}, '', url);
  }
});
