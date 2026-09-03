/**
 * Where deals live.
 *
 * Two backends behind one interface:
 *
 *   LOCAL   localStorage, single user, no server. Exactly what the app did
 *           before there was an API, and still a supported mode — a solo
 *           analyst, a laptop demo, the test suite. Not a degraded fallback.
 *   REMOTE  the multi-tenant API, where deals are isolated per firm by
 *           Postgres row level security and every write is attributed.
 *
 * Chosen by whether REACT_APP_API_URL is set, and by nothing else. There is no
 * runtime toggle, because a persistence layer that can change under a running
 * app is a way to write into the wrong place — and in remote mode "the wrong
 * place" means a browser rather than a client firm's audited store.
 *
 * The interface is asynchronous even for the local backend. localStorage is
 * synchronous, so this costs a microtask that mode does not need; the
 * alternative is two call shapes and a caller that has to know which it is
 * talking to, which is how the wrong one gets awaited and silently ignored.
 */

import { loadDeals as loadLocal, saveDeals as saveLocal, storageStatus } from './storage';
import { api, isMultiTenant, ApiError } from './api';

/**
 * The deal shape differs between the two.
 *
 * Locally a deal is one flat object. Remotely the server owns `id`, `name` and
 * `stage` as columns (it indexes and orders by them) and everything else is an
 * opaque `payload` — deliberately, because the underwriting shape is decided by
 * finance.js and changes with underwriting policy, and pinning it into columns
 * would make every policy change a database migration.
 *
 * These two functions are the only place that seam exists.
 */
const toClient = (row) => ({
  ...row.payload,
  id: row.id,
  name: row.name,
  stage: row.stage ?? undefined,
  updatedAt: row.updated_at,
});

const toServer = (deal) => {
  // Derived values are never sent. They are recomputed from the payload on
  // read, and storing them would let a stale cached number survive an engine
  // correction — the same rule storage.js applies locally.
  const { id, metrics, model, updatedAt, name, stage, ...payload } = deal || {};
  return { name: name || 'Untitled deal', stage: stage ?? null, payload };
};

const localStore = {
  mode: 'local',

  async list() {
    const { deals, error } = loadLocal();
    return { deals, error };
  },

  /**
   * Local mode saves the WHOLE collection on every change, because that is what
   * localStorage is: one key holding one document. The remote backend does not,
   * and must not — see below.
   */
  async saveAll(deals) {
    const { ok, error } = saveLocal(deals);
    return { ok, error };
  },

  async create(deal) { return deal; },
  async update(deal) { return deal; },
  async remove() { return true; },
  async status() { return storageStatus(); },
};

const remoteStore = {
  mode: 'remote',

  async list() {
    try {
      return { deals: (await api.listDeals()).map(toClient), error: null };
    } catch (err) {
      // Distinguished so App can send the user to sign in rather than showing
      // a storage error for what is really an expired session.
      if (err instanceof ApiError && err.status === 401) return { deals: null, error: 'unauthenticated' };
      return { deals: null, error: 'unreachable' };
    }
  },

  /**
   * DELIBERATELY NOT IMPLEMENTED, rather than looping over create/update.
   *
   * Writing the whole collection on every keystroke is fine against one
   * browser's localStorage and is wrong against a shared server: it would
   * overwrite a colleague's concurrent edit to a different deal with whatever
   * this tab last read, and it turns one changed field into N requests. Remote
   * mode writes the deal that changed, and only when it changes.
   */
  async saveAll() {
    throw new Error('remote mode saves per deal; call create/update/remove');
  },

  async create(deal) { return toClient(await api.createDeal(toServer(deal))); },
  async update(deal) { return toClient(await api.updateDeal(deal.id, toServer(deal))); },
  async remove(id) { await api.deleteDeal(id); return true; },
  async status() { return 'available'; },
};

export const dealStore = isMultiTenant() ? remoteStore : localStore;
export const __internals = { toClient, toServer, localStore, remoteStore };
