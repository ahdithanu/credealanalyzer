import React, { useState } from 'react';
import { api } from '../lib/api';

/**
 * The sign-in gate.
 *
 * There is no password field, and that is the product: authentication happens
 * at the firm's own identity provider, so this app never sees a credential and
 * has none to leak. Offboarding someone in their directory offboards them here.
 *
 * The only input is which firm they belong to, and it is a ROUTING hint —
 * it decides which identity provider to redirect to and nothing else. The
 * tenant a user lands in comes from the provider's assertion. Typing another
 * firm's name here sends you to a directory that will refuse to authenticate
 * you; it does not get you their data.
 */

/** Reasons the callback can bounce back, in words a person can act on. */
const ERRORS = {
  bad_state: 'That sign-in link has expired or was already used. Please try again.',
  unknown_org: 'Your organization is not set up on this platform yet. Contact your administrator.',
  tenant_suspended: 'Access for your organization is currently suspended. Contact your administrator.',
  unverified_email: 'Your identity provider did not confirm your email address. Contact your IT team.',
  domain_not_verified: 'Your email domain is not verified for this organization. Contact your administrator.',
  bad_email: 'Your identity provider supplied an email address we could not read. Contact your IT team.',
  no_org: 'Your identity provider did not say which organization you belong to. Contact your IT team.',
};

export default function SignIn({ status }) {
  const [org, setOrg] = useState('');
  const params = new URLSearchParams(window.location.search);
  const errorCode = params.get('error');
  // An unrecognised code is shown as a generic failure rather than echoed:
  // reflecting an arbitrary query parameter into the page is how a phishing
  // link gets to put its own words on our domain.
  const error = errorCode ? (ERRORS[errorCode] || 'Sign-in did not complete. Please try again.') : null;

  const unreachable = status === 'unreachable';

  return (
    <div className="signin-shell">
      <div className="signin-card">
        <div className="signin-mark">CRE</div>
        <h1>Deal Analyzer</h1>
        <p className="signin-sub">Sign in with your firm’s single sign-on.</p>

        {error ? <div className="signin-error" role="alert">{error}</div> : null}
        {unreachable ? (
          <div className="signin-error" role="alert">
            Cannot reach the service right now. This is not a sign-in problem — try again shortly.
          </div>
        ) : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            api.signIn({ org: org.trim() || undefined, next: '/' });
          }}
        >
          <label htmlFor="org" className="lbl">Firm</label>
          <input
            id="org"
            className="signin-input"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="your-firm"
            autoComplete="organization"
            spellCheck={false}
            disabled={unreachable}
          />
          <p className="signin-hint">
            Optional. Leave blank and you’ll be asked which firm you belong to.
          </p>
          <button type="submit" className="signin-button" disabled={unreachable}>
            Continue with SSO
          </button>
        </form>

        <p className="signin-foot">
          Your deals are visible only to your firm.
        </p>
      </div>
    </div>
  );
}
