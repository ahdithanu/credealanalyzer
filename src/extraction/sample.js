/**
 * Which properties in a filing get labelled.
 *
 * A 10-K describes dozens to hundreds of properties and the schema describes
 * one, so the eval unit is (filing, property). Labelling all of them is not
 * possible by hand; labelling the ones that look easy is how an eval ends up
 * measuring the labeller's taste. So the subjects are drawn by a rule that
 * does not look at the row's contents: hash the entry id and the subject's
 * name, sort, take the first n.
 *
 * FNV-1a over UTF-16 code units. It is not cryptographic and does not need to
 * be; it needs to be stable across machines and runtimes, and impossible to
 * steer without visibly editing the population list in the manifest.
 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * @param {string} entryId     manifest entry id, so two filings sharing a
 *                             property name draw independently
 * @param {string[]} population every eligible subject, verbatim
 * @param {number} n
 * @returns {string[]} the drawn subjects, in draw order
 */
export function sampleSubjects(entryId, population, n) {
  if (new Set(population).size !== population.length) {
    // A duplicate would be drawn twice or shadow its twin, depending on order.
    throw new Error(`population for ${entryId} contains duplicate subjects`);
  }
  return population
    .map((name) => ({ name, key: fnv1a(`${entryId}|${name}`) }))
    .sort((a, b) => a.key - b.key || (a.name < b.name ? -1 : 1))
    .slice(0, n)
    .map((x) => x.name);
}
