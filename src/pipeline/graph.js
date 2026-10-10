/**
 * Property graph over CRE entities.
 *
 * Holds entities and the relationships between them — parcels, owning
 * entities, jurisdictions, geography, transactions. It deliberately does NOT
 * hold observations: population by year, rent by quarter and assessed value by
 * roll year live in the FactStore, and the node carries only an id the facts
 * hang off.
 *
 * That split is the whole design. Putting time series in a graph is how graph
 * projects die — traversal gets slow, the model gets muddy, and none of the
 * aggregate queries you actually want are expressible.
 */

export const NODE_TYPES = [
  'Parcel', 'Building', 'Entity', 'Person', 'Jurisdiction',
  'Tract', 'Submarket', 'Metro', 'County', 'Transaction', 'Tenant',
];

export const EDGE_TYPES = [
  'located_in',    // Parcel  -> Tract | Submarket | Metro | County
  'owned_by',      // Parcel  -> Entity
  'controlled_by', // Entity  -> Entity  (SPE up to holdco)
  'principal_of',  // Person  -> Entity
  'taxed_by',      // Parcel  -> Jurisdiction
  'sold_in',       // Parcel  -> Transaction
  'party_to',      // Entity  -> Transaction
  'leases',        // Tenant  -> Building
  'guaranteed_by', // Tenant  -> Entity
  'comparable_to', // Transaction -> Transaction
];

export class Graph {
  constructor() {
    this.nodes = new Map();           // id -> { id, type, props }
    this.out = new Map();             // id -> Edge[]
    this.in = new Map();              // id -> Edge[]
    this.edges = [];
  }

  addNode({ id, type, props = {} }) {
    if (!id) throw new Error('a node needs an id');
    if (!NODE_TYPES.includes(type)) throw new Error(`unknown node type: ${type}`);
    const existing = this.nodes.get(id);
    if (existing) {
      if (existing.type !== type) {
        throw new Error(`node ${id} already exists as ${existing.type}, cannot re-add as ${type}`);
      }
      // Upsert: merge props so repeated ingestion is idempotent.
      existing.props = { ...existing.props, ...props };
      return existing;
    }
    const node = { id, type, props };
    this.nodes.set(id, node);
    return node;
  }

  getNode(id) { return this.nodes.get(id) ?? null; }

  addEdge({ from, to, type, props = {} }) {
    if (!EDGE_TYPES.includes(type)) throw new Error(`unknown edge type: ${type}`);
    if (!this.nodes.has(from)) throw new Error(`edge ${type} references unknown node ${from}`);
    if (!this.nodes.has(to)) throw new Error(`edge ${type} references unknown node ${to}`);
    // Idempotent on (from, to, type).
    const dup = (this.out.get(from) ?? []).find((e) => e.to === to && e.type === type);
    if (dup) { dup.props = { ...dup.props, ...props }; return dup; }

    const edge = { from, to, type, props };
    this.edges.push(edge);
    if (!this.out.has(from)) this.out.set(from, []);
    if (!this.in.has(to)) this.in.set(to, []);
    this.out.get(from).push(edge);
    this.in.get(to).push(edge);
    return edge;
  }

  /** Adjacent edges. `direction` is 'out' | 'in' | 'both'. */
  edgesOf(id, { type = null, direction = 'out' } = {}) {
    const pick = [];
    if (direction === 'out' || direction === 'both') pick.push(...(this.out.get(id) ?? []));
    if (direction === 'in' || direction === 'both') pick.push(...(this.in.get(id) ?? []));
    const types = type === null ? null : (Array.isArray(type) ? type : [type]);
    return types ? pick.filter((e) => types.includes(e.type)) : pick;
  }

  neighbors(id, opts = {}) {
    return this.edgesOf(id, opts).map((e) => this.nodes.get(e.from === id ? e.to : e.from));
  }

  /**
   * Breadth-first traversal returning the path to each reachable node.
   * Cycles are common in ownership (circular SPE structures are a real thing),
   * so visited-tracking is not optional.
   */
  traverse(startId, { edgeTypes = null, direction = 'out', maxDepth = 6 } = {}) {
    if (!this.nodes.has(startId)) return [];
    const seen = new Set([startId]);
    const results = [];
    let frontier = [{ id: startId, path: [] }];

    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next = [];
      for (const { id, path } of frontier) {
        for (const edge of this.edgesOf(id, { type: edgeTypes, direction })) {
          const other = edge.from === id ? edge.to : edge.from;
          if (seen.has(other)) continue;
          seen.add(other);
          const hop = { id: other, path: [...path, edge], depth: depth + 1 };
          results.push(hop);
          next.push({ id: other, path: hop.path });
        }
      }
      frontier = next;
    }
    return results;
  }

  /**
   * Ultimate beneficial ownership: walk Parcel -> Entity -> ... -> the entities
   * with nothing above them, plus any people named as principals.
   *
   * This is the query that justifies the graph. CRE title runs through layers
   * of single-purpose entities specifically so that "who owns this" is not
   * answerable from one record, and the depth is not known in advance — which
   * is exactly what a relational join cannot express.
   */
  beneficialOwners(parcelId) {
    const reached = this.traverse(parcelId, {
      edgeTypes: ['owned_by', 'controlled_by'],
      direction: 'out',
      maxDepth: 12,
    });
    const owners = [];
    for (const hop of reached) {
      const node = this.nodes.get(hop.id);
      if (node.type !== 'Entity') continue;
      const upstream = this.edgesOf(hop.id, { type: 'controlled_by', direction: 'out' });
      if (upstream.length > 0) continue;      // not ultimate; something controls it
      owners.push({
        entity: node,
        depth: hop.depth,
        chain: hop.path.map((e) => e.to),
        principals: this.edgesOf(hop.id, { type: 'principal_of', direction: 'in' })
          .map((e) => this.nodes.get(e.from)),
      });
    }
    return owners.sort((a, b) => a.depth - b.depth);
  }

  /** Every parcel an entity controls, directly or through anything below it. */
  portfolioOf(entityId) {
    const controlled = this.traverse(entityId, {
      edgeTypes: ['controlled_by'], direction: 'in', maxDepth: 12,
    }).map((h) => h.id);
    const entityIds = new Set([entityId, ...controlled]);
    const parcels = new Set();
    for (const id of entityIds) {
      for (const e of this.edgesOf(id, { type: 'owned_by', direction: 'in' })) {
        parcels.add(e.from);
      }
    }
    return [...parcels].map((id) => this.nodes.get(id));
  }

  /**
   * True when two entities share any owner, which is how a related-party
   * transfer is detected and excluded from a comparable set.
   */
  relatedParty(entityA, entityB) {
    if (entityA === entityB) return true;
    const up = (id) => new Set([
      id,
      ...this.traverse(id, { edgeTypes: ['controlled_by'], direction: 'out', maxDepth: 12 }).map((h) => h.id),
    ]);
    const a = up(entityA);
    for (const id of up(entityB)) if (a.has(id)) return true;
    return false;
  }

  /** Nodes of a type, optionally filtered on props. */
  nodesOfType(type, predicate = null) {
    const out = [];
    for (const n of this.nodes.values()) {
      if (n.type === type && (!predicate || predicate(n))) out.push(n);
    }
    return out;
  }

  get stats() {
    const byType = {};
    for (const n of this.nodes.values()) byType[n.type] = (byType[n.type] ?? 0) + 1;
    const byEdge = {};
    for (const e of this.edges) byEdge[e.type] = (byEdge[e.type] ?? 0) + 1;
    return { nodes: this.nodes.size, edges: this.edges.length, byType, byEdge };
  }

  toJSON() {
    // Copies, not the live objects. Handing out `this.edges` and the node
    // records themselves means a caller that edits the serialised result edits
    // the graph — a snapshot writer that normalised props before storing them
    // would silently rewrite the graph it was asked to serialise.
    return {
      nodes: [...this.nodes.values()].map((n) => ({ ...n, props: { ...n.props } })),
      edges: this.edges.map((e) => ({ ...e })),
    };
  }

  static fromJSON(json) {
    const g = new Graph();
    for (const n of json?.nodes ?? []) g.addNode(n);
    for (const e of json?.edges ?? []) g.addEdge(e);
    return g;
  }
}
