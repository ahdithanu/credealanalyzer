/**
 * The document intake methods on the API client: uploadDocument, listDocuments
 * and getDocument.
 *
 * api.js reads REACT_APP_API_URL once at import time, so each test loads it
 * fresh after setting the variable (see screens/__tests__/multiTenant.test.js
 * for the long version of why). fetch is scripted; nothing reaches a network.
 * The PDF bytes below are a FIXTURE, not a document.
 */

const API = 'https://api.test.example';

async function loadApi(respond) {
  vi.resetModules();
  process.env.REACT_APP_API_URL = API;
  const calls = [];
  global.fetch = vi.fn(async (url, init = {}) => {
    calls.push({ url, init });
    return respond(url, init);
  });
  const mod = await import('../api');
  return { ...mod, calls };
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

afterEach(() => {
  delete process.env.REACT_APP_API_URL;
  vi.resetModules();
});

const FIXTURE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
const fixtureFile = (name = 'Fixture OM, café.pdf') => new File([FIXTURE_BYTES], name, { type: 'application/pdf' });

test('uploadDocument posts the raw file with the PDF content type, filename and CSRF token', async () => {
  const meta = { id: 'doc-1', dealId: 'deal-1', filename: 'Fixture OM, café.pdf', textLayer: 'present' };
  const { api, setCsrfToken, calls } = await loadApi(() => json(201, meta));
  setCsrfToken('csrf-abc');
  const file = fixtureFile();

  const out = await api.uploadDocument('deal-1', file);

  expect(out).toEqual(meta);
  expect(calls).toHaveLength(1);
  const { url, init } = calls[0];
  expect(url).toBe(`${API}/api/deals/deal-1/documents`);
  expect(init.method).toBe('POST');
  expect(init.credentials).toBe('include');
  expect(init.headers['content-type']).toBe('application/pdf');
  expect(init.headers['x-csrf-token']).toBe('csrf-abc');
  expect(init.headers['x-filename']).toBe(encodeURIComponent('Fixture OM, café.pdf'));
  // The file itself, not a JSON string of it and not a form.
  expect(init.body).toBe(file);
});

test('uploadDocument surfaces the server refusal code', async () => {
  const { api, ApiError } = await loadApi(() => json(422, { error: 'pdf_encrypted' }));
  const err = await api.uploadDocument('deal-1', fixtureFile()).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(422);
  expect(err.code).toBe('pdf_encrypted');
});

test('listDocuments GETs the deal\'s list and returns the array', async () => {
  const docs = [{ id: 'doc-1' }, { id: 'doc-2' }];
  const { api, setCsrfToken, calls } = await loadApi(() => json(200, { documents: docs }));
  setCsrfToken('csrf-abc');
  expect(await api.listDocuments('deal-1')).toEqual(docs);
  expect(calls[0].url).toBe(`${API}/api/deals/deal-1/documents`);
  expect(calls[0].init.method).toBe('GET');
  expect(calls[0].init.headers['x-csrf-token']).toBeUndefined();
  expect(calls[0].init.body).toBeUndefined();
});

test('getDocument returns contract C1 as the server sent it', async () => {
  const c1 = {
    id: 'doc-1', dealId: 'deal-1', filename: 'f.pdf', sha256: 'a'.repeat(64), byteSize: 8,
    pageCount: 1, textLayer: 'present', pages: [{ page: 1, text: 'FIXTURE line one\nline two' }],
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  const { api, calls } = await loadApi(() => json(200, c1));
  expect(await api.getDocument('deal-1', 'doc-1')).toEqual(c1);
  expect(calls[0].url).toBe(`${API}/api/deals/deal-1/documents/doc-1`);
});

test('ids are path-encoded, so an id cannot walk to another route', async () => {
  const { api, calls } = await loadApi(() => json(200, { documents: [] }));
  await api.listDocuments('../../auth/logout');
  expect(calls[0].url).toBe(`${API}/api/deals/..%2F..%2Fauth%2Flogout/documents`);
});

test('a JSON request still sends JSON: the raw path did not change it', async () => {
  const { api, calls } = await loadApi(() => json(201, { deal: { id: 'd' } }));
  await api.createDeal({ name: 'n', payload: {} });
  expect(calls[0].init.headers['content-type']).toBe('application/json');
  expect(calls[0].init.body).toBe(JSON.stringify({ name: 'n', payload: {} }));
});

test('in single-user mode the document methods refuse rather than invent', async () => {
  vi.resetModules();
  delete process.env.REACT_APP_API_URL;
  global.fetch = vi.fn();
  const { api } = await import('../api');
  await expect(api.listDocuments('deal-1')).rejects.toMatchObject({ code: 'no_api' });
  await expect(api.uploadDocument('deal-1', fixtureFile())).rejects.toMatchObject({ code: 'no_api' });
  expect(global.fetch).not.toHaveBeenCalled();
});
