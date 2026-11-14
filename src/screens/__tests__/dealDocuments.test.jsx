/**
 * The Documents panel on the deal model screen.
 *
 * Two properties: in single-user mode there is no panel and no request (there
 * is no server to hold a document, and a placeholder list would be a fake
 * source); in multi-tenant mode the list is the server's, uploads go through
 * api.uploadDocument, and a refusal is shown in words rather than swallowed.
 *
 * Every document and file below is a TEST FIXTURE.
 */

import React from 'react';
import * as testUtils from 'react-dom/test-utils';

import DealModel from '../DealModel';
import { SAMPLE_DEALS } from '../../lib/sampleDeals';
import { renderScreen, withScreen, text } from '../testing/renderScreen';

const act = typeof React.act === 'function' ? React.act : testUtils.act;
const API = 'https://api.test.example';
const noop = () => {};

async function loadMultiTenant(respond) {
  vi.resetModules();
  process.env.REACT_APP_API_URL = API;
  const calls = [];
  global.fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method || 'GET', init });
    return respond(`${init.method || 'GET'} ${u.pathname}`, init);
  });
  const mod = await import('../DealModel');
  return { DealDocuments: mod.DealDocuments, calls };
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function chooseFile(container, file) {
  const input = container.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
}

afterEach(() => {
  delete process.env.REACT_APP_API_URL;
  vi.restoreAllMocks();
  vi.resetModules();
});

const FIXTURE_DOC = {
  id: 'doc-1', dealId: 'deal-1', filename: 'Fixture rent roll.pdf', sha256: 'a'.repeat(64),
  byteSize: 2048, pageCount: 3, textLayer: 'present', createdAt: '2026-11-01T00:00:00.000Z',
};

test('single-user mode shows no documents panel and makes no request', () => {
  global.fetch = vi.fn();
  withScreen(<DealModel deal={SAMPLE_DEALS[0]} onChange={noop} posture="form" onPosture={noop} />, (c) => {
    expect(text(c)).not.toMatch(/Documents/);
    expect(c.querySelector('input[type="file"]')).toBe(null);
  });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('multi-tenant mode lists the server\'s documents for the deal', async () => {
  const { DealDocuments, calls } = await loadMultiTenant(() => json(200, { documents: [FIXTURE_DOC] }));
  const { container, unmount } = renderScreen(<DealDocuments dealId="deal-1" />);
  await flush();
  expect(calls.some((c) => c.path === '/api/deals/deal-1/documents' && c.method === 'GET')).toBe(true);
  expect(text(container)).toMatch(/Fixture rent roll\.pdf/);
  expect(text(container)).toMatch(/3 pages/);
  expect(text(container)).not.toMatch(/no text layer/);
  unmount();
});

test('an empty list says so only after the server answered', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { DealDocuments } = await loadMultiTenant(async () => { await gate; return json(200, { documents: [] }); });
  const { container, unmount } = renderScreen(<DealDocuments dealId="deal-1" />);
  expect(text(container)).not.toMatch(/No documents uploaded/);
  release();
  await flush();
  expect(text(container)).toMatch(/No documents uploaded/);
  unmount();
});

test('a scanned document is marked as having no text layer', async () => {
  const scan = { ...FIXTURE_DOC, id: 'doc-2', filename: 'Fixture scan.pdf', textLayer: 'absent' };
  const { DealDocuments } = await loadMultiTenant(() => json(200, { documents: [scan] }));
  const { container, unmount } = renderScreen(<DealDocuments dealId="deal-1" />);
  await flush();
  expect(text(container)).toMatch(/no text layer/);
  unmount();
});

test('choosing a file uploads it and adds the stored document to the list', async () => {
  const stored = { ...FIXTURE_DOC, id: 'doc-9', filename: 'Fixture OM.pdf', pageCount: 1 };
  const { DealDocuments, calls } = await loadMultiTenant((key) => (key === 'POST /api/deals/deal-1/documents'
    ? json(201, stored) : json(200, { documents: [] })));
  const { container, unmount } = renderScreen(<DealDocuments dealId="deal-1" />);
  await flush();
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'Fixture OM.pdf', { type: 'application/pdf' });
  await chooseFile(container, file);
  const post = calls.find((c) => c.method === 'POST');
  expect(post.init.body).toBe(file);
  expect(post.init.headers['content-type']).toBe('application/pdf');
  expect(text(container)).toMatch(/Fixture OM\.pdf/);
  expect(text(container)).toMatch(/1 page(?!s)/);
  unmount();
});

test('a refused upload is shown in words and adds nothing to the list', async () => {
  const { DealDocuments } = await loadMultiTenant((key) => (key.startsWith('POST')
    ? json(422, { error: 'pdf_encrypted' }) : json(200, { documents: [] })));
  const { container, unmount } = renderScreen(<DealDocuments dealId="deal-1" />);
  await flush();
  await chooseFile(container, new File([new Uint8Array([1])], 'Fixture locked.pdf', { type: 'application/pdf' }));
  expect(container.querySelector('[role="alert"]').textContent).toMatch(/password protected/);
  expect(text(container)).toMatch(/No documents uploaded/);
  unmount();
});

test('a list that cannot load says so instead of claiming there are no documents', async () => {
  const { DealDocuments } = await loadMultiTenant(() => json(500, { error: 'internal' }));
  const { container, unmount } = renderScreen(<DealDocuments dealId="deal-1" />);
  await flush();
  expect(text(container)).toMatch(/could not be loaded/);
  expect(text(container)).not.toMatch(/No documents uploaded/);
  unmount();
});
