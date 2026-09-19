import React, { useState } from 'react';
import { api } from '../lib/api';

/**
 * The sign-in portal.
 *
 * There is no password field, and that is the product: authentication happens
 * at the firm's own identity provider, so this app never sees a credential and
 * has none to leak. Offboarding someone in their directory offboards them here.
 *
 * The only input is a work email address, and it is a ROUTING hint — its domain
 * decides which identity provider to redirect to, and nothing else. The tenant
 * a user lands in comes from the provider's assertion, and the verified-domain
 * check on the server is what stands between an address and a firm's data.
 * Typing a competitor's address here sends you to a directory that will refuse
 * to authenticate you; it does not get you their deals.
 *
 * It asked for a firm slug before, which is a thing nobody knows about
 * themselves. An analyst at Acme knows their email address.
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
  mfa_required: 'Your organization requires multi-factor authentication, and your identity provider '
    + 'did not confirm it was used. Contact your IT team.',
  // Duo. Deliberately one message for every cause the server distinguishes —
  // a refused credential, a bad signature, an unreachable service. The operator
  // log carries the detail; this page must not become a way to probe a firm's
  // Duo configuration from outside it.
  mfa_failed: 'We could not complete the second security step. Please try again, or contact '
    + 'your IT team if it keeps happening.',
  mfa_denied: 'The second security step was declined or timed out. Please try again.',
};

/** A shape check only. Whether the address exists is the directory's business. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function SignIn({ status }) {
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const errorCode = params.get('error');
  // An unrecognised code is shown as a generic failure rather than echoed:
  // reflecting an arbitrary query parameter into the page is how a phishing
  // link gets to put its own words on our domain.
  const error = errorCode ? (ERRORS[errorCode] || 'Sign-in did not complete. Please try again.') : null;

  const unreachable = status === 'unreachable';
  const value = email.trim();
  const valid = LOOKS_LIKE_EMAIL.test(value);
  // Only after they have tried, so the form does not scold someone mid-typing.
  const showInvalid = touched && value.length > 0 && !valid;

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
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!valid || unreachable) return;
            api.signIn({ email: value, next: '/' });
          }}
        >
          <label htmlFor="email" className="lbl">Work email</label>
          <input
            id="email"
            type="email"
            className="signin-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="you@yourfirm.com"
            autoComplete="username email"
            autoCapitalize="none"
            spellCheck={false}
            disabled={unreachable}
            aria-invalid={showInvalid || undefined}
            aria-describedby="email-hint"
          />
          <p className="signin-hint" id="email-hint">
            {showInvalid
              ? 'That does not look like an email address.'
              : 'We’ll send you to your firm’s identity provider. No password is entered here.'}
          </p>
          <button
            type="submit"
            className="signin-button"
            disabled={unreachable || (touched && !valid)}
          >
            Continue with SSO
          </button>
        </form>

        <p className="signin-foot">
          Your deals are visible only to your firm. Some firms add a second
          security step after this.
        </p>
      </div>
    </div>
  );
}
