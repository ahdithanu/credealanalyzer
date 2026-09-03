import { useCallback, useEffect, useState } from 'react';
import { api, isMultiTenant, setCsrfToken } from './api';

/**
 * Who is signed in.
 *
 * Three states, and they are NOT collapsible into two. `loading` exists because
 * the answer needs a round trip: rendering the sign-in screen while /auth/me is
 * still in flight flashes a login page at somebody who is already signed in,
 * every single page load. Rendering the app instead would flash a client's deal
 * list at someone who is not.
 *
 * In single-user mode there is no session and no server to ask, so it resolves
 * immediately to a synthetic local identity. The app renders the same either
 * way; only the chrome differs.
 */
export function useSession() {
  const [state, setState] = useState(() => (
    isMultiTenant()
      ? { status: 'loading', user: null, tenant: null }
      // Not a real identity and named so nobody mistakes it for one. Nothing
      // is attributed to it and no isolation depends on it.
      : { status: 'local', user: null, tenant: null }
  ));

  const refresh = useCallback(async () => {
    if (!isMultiTenant()) return;
    try {
      const me = await api.me();
      setState(me
        ? { status: 'authenticated', user: me.user, tenant: me.tenant, expiresAt: me.expiresAt }
        : { status: 'anonymous', user: null, tenant: null });
    } catch {
      // The API is unreachable, which is NOT the same as being signed out. If
      // this reported 'anonymous' the user would be shown a sign-in button that
      // cannot work, and clicking it would navigate them away from an app that
      // was about to recover.
      setState({ status: 'unreachable', user: null, tenant: null });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const signOut = useCallback(async () => {
    try { await api.signOut(); } catch { /* the cookie may already be gone */ }
    setCsrfToken(null);
    setState({ status: 'anonymous', user: null, tenant: null });
  }, []);

  return { ...state, refresh, signOut };
}
