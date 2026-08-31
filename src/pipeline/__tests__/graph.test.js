import { Graph } from '../graph';

/**
 * A deliberately realistic ownership structure:
 *
 *   parcel:a ─owned_by─> spe:1 ─controlled_by─> holdco:sunbelt <─principal_of─ person:okonjo
 *   parcel:b ─owned_by─> spe:2 ─controlled_by─> holdco:sunbelt
 *   parcel:c ─owned_by─> spe:3 ─controlled_by─> holdco:rival
 */
function fixture() {
  const g = new Graph();
  for (const id of ['parcel:a', 'parcel:b', 'parcel:c']) g.addNode({ id, type: 'Parcel' });
  for (const id of ['spe:1', 'spe:2', 'spe:3', 'holdco:sunbelt', 'holdco:rival']) {
    g.addNode({ id, type: 'Entity' });
  }
  g.addNode({ id: 'person:okonjo', type: 'Person', props: { name: 'A. Okonjo' } });
  g.addNode({ id: 'metro:houston', type: 'Metro' });

  g.addEdge({ from: 'parcel:a', to: 'spe:1', type: 'owned_by' });
  g.addEdge({ from: 'parcel:b', to: 'spe:2', type: 'owned_by' });
  g.addEdge({ from: 'parcel:c', to: 'spe:3', type: 'owned_by' });
  g.addEdge({ from: 'spe:1', to: 'holdco:sunbelt', type: 'controlled_by' });
  g.addEdge({ from: 'spe:2', to: 'holdco:sunbelt', type: 'controlled_by' });
  g.addEdge({ from: 'spe:3', to: 'holdco:rival', type: 'controlled_by' });
  g.addEdge({ from: 'person:okonjo', to: 'holdco:sunbelt', type: 'principal_of' });
  g.addEdge({ from: 'parcel:a', to: 'metro:houston', type: 'located_in' });
  return g;
}

describe('Graph — structure', () => {
  it('rejects unknown node and edge types', () => {
    const g = new Graph();
    expect(() => g.addNode({ id: 'x', type: 'Spaceship' })).toThrow(/unknown node type/);
    g.addNode({ id: 'a', type: 'Parcel' });
    g.addNode({ id: 'b', type: 'Entity' });
    expect(() => g.addEdge({ from: 'a', to: 'b', type: 'befriends' })).toThrow(/unknown edge type/);
  });

  it('rejects an edge to a node that does not exist', () => {
    const g = new Graph();
    g.addNode({ id: 'a', type: 'Parcel' });
    expect(() => g.addEdge({ from: 'a', to: 'ghost', type: 'owned_by' })).toThrow(/unknown node ghost/);
  });

  it('refuses to change a node type on re-add', () => {
    const g = new Graph();
    g.addNode({ id: 'a', type: 'Parcel' });
    expect(() => g.addNode({ id: 'a', type: 'Entity' })).toThrow(/already exists as Parcel/);
  });

  it('is idempotent on repeated ingestion', () => {
    const g = fixture();
    const before = g.stats;
    g.addNode({ id: 'parcel:a', type: 'Parcel', props: { apn: '123' } });
    g.addEdge({ from: 'parcel:a', to: 'spe:1', type: 'owned_by' });
    expect(g.stats.nodes).toBe(before.nodes);
    expect(g.stats.edges).toBe(before.edges);
    expect(g.getNode('parcel:a').props.apn).toBe('123');   // props merge
  });
});

describe('Graph — traversal', () => {
  it('walks outward and records the path', () => {
    const g = fixture();
    const hops = g.traverse('parcel:a', { edgeTypes: ['owned_by', 'controlled_by'] });
    const ids = hops.map((h) => h.id);
    expect(ids).toContain('spe:1');
    expect(ids).toContain('holdco:sunbelt');
    expect(hops.find((h) => h.id === 'holdco:sunbelt').depth).toBe(2);
  });

  it('respects maxDepth', () => {
    const g = fixture();
    const hops = g.traverse('parcel:a', { edgeTypes: ['owned_by', 'controlled_by'], maxDepth: 1 });
    expect(hops.map((h) => h.id)).toEqual(['spe:1']);
  });

  it('terminates on a cycle', () => {
    // Circular control structures exist; the traversal must not hang.
    const g = new Graph();
    g.addNode({ id: 'e1', type: 'Entity' });
    g.addNode({ id: 'e2', type: 'Entity' });
    g.addEdge({ from: 'e1', to: 'e2', type: 'controlled_by' });
    g.addEdge({ from: 'e2', to: 'e1', type: 'controlled_by' });
    const hops = g.traverse('e1', { edgeTypes: ['controlled_by'], maxDepth: 50 });
    expect(hops.map((h) => h.id)).toEqual(['e2']);
  });

  it('filters by edge type', () => {
    const g = fixture();
    const geo = g.traverse('parcel:a', { edgeTypes: ['located_in'] });
    expect(geo.map((h) => h.id)).toEqual(['metro:houston']);
  });
});

describe('Graph — beneficial ownership', () => {
  it('resolves through the SPE layer to the ultimate owner', () => {
    const g = fixture();
    const owners = g.beneficialOwners('parcel:a');
    expect(owners.map((o) => o.entity.id)).toEqual(['holdco:sunbelt']);
    expect(owners[0].depth).toBe(2);
  });

  it('names the principals behind the ultimate owner', () => {
    const g = fixture();
    expect(g.beneficialOwners('parcel:a')[0].principals.map((p) => p.props.name)).toEqual(['A. Okonjo']);
  });

  it('treats a directly-held parcel as its own ultimate owner', () => {
    const g = new Graph();
    g.addNode({ id: 'p', type: 'Parcel' });
    g.addNode({ id: 'e', type: 'Entity' });
    g.addEdge({ from: 'p', to: 'e', type: 'owned_by' });
    expect(g.beneficialOwners('p').map((o) => o.entity.id)).toEqual(['e']);
  });

  it('returns nothing for a parcel with no recorded owner', () => {
    const g = fixture();
    g.addNode({ id: 'parcel:orphan', type: 'Parcel' });
    expect(g.beneficialOwners('parcel:orphan')).toEqual([]);
  });
});

describe('Graph — portfolio and related parties', () => {
  it('rolls up every parcel held beneath a holdco', () => {
    const g = fixture();
    const portfolio = g.portfolioOf('holdco:sunbelt').map((p) => p.id).sort();
    expect(portfolio).toEqual(['parcel:a', 'parcel:b']);
  });

  it('excludes parcels held by an unrelated holdco', () => {
    const g = fixture();
    expect(g.portfolioOf('holdco:sunbelt').map((p) => p.id)).not.toContain('parcel:c');
  });

  it('detects a related-party pair sharing an ultimate owner', () => {
    // The reason this matters: a transfer between spe:1 and spe:2 is not an
    // arm's-length comparable, and must be excluded from a comp set.
    const g = fixture();
    expect(g.relatedParty('spe:1', 'spe:2')).toBe(true);
  });

  it('treats entities under different owners as unrelated', () => {
    const g = fixture();
    expect(g.relatedParty('spe:1', 'spe:3')).toBe(false);
  });

  it('treats an entity as related to itself', () => {
    expect(fixture().relatedParty('spe:1', 'spe:1')).toBe(true);
  });
});

describe('Graph — stats and serialisation', () => {
  it('counts nodes and edges by type', () => {
    const s = fixture().stats;
    expect(s.byType.Parcel).toBe(3);
    expect(s.byType.Entity).toBe(5);
    expect(s.byEdge.owned_by).toBe(3);
  });

  it('round-trips through JSON', () => {
    const g = fixture();
    const back = Graph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    expect(back.stats).toEqual(g.stats);
    expect(back.beneficialOwners('parcel:a')[0].entity.id).toBe('holdco:sunbelt');
  });
});
