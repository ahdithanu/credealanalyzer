'use strict';

const { create, verifyDomain } = require('./tenants');

/**
 * Seed two demo tenants.
 *
 * TWO, not one, and that is the whole point of the demo: the product's central
 * claim is that Firm X cannot see Firm Y's deals. One tenant demonstrates a
 * login. Two demonstrate the boundary — sign in as each in separate windows and
 * the pipelines are disjoint.
 *
 * Idempotent: re-running is a no-op rather than an error, so `docker compose up`
 * a second time does not fail on a duplicate slug.
 */
const DEMO = [
  { slug: 'firm-x', name: 'Firm X Capital', org: 'org_firm_x', domain: 'firmx.com' },
  { slug: 'firm-y', name: 'Firm Y Partners', org: 'org_firm_y', domain: 'firmy.com' },
];

async function seedDemo({ log = console.log } = {}) {
  const out = [];
  for (const t of DEMO) {
    try {
      await create(t);
      log(`created tenant ${t.slug}`);
    } catch (err) {
      // Already there. Anything else is a real failure and must surface.
      if (!/duplicate key|unique/i.test(err.message)) throw err;
      log(`tenant ${t.slug} already exists`);
    }
    await verifyDomain({ slug: t.slug, domain: t.domain });
    out.push({ ...t });
  }
  return out;
}

module.exports = { seedDemo, DEMO };

if (require.main === module) {
  seedDemo()
    .then((rows) => {
      console.log('\nSign in at http://localhost:3000 with either:');
      for (const r of rows) {
        console.log(`  ${r.name.padEnd(18)} firm: ${r.slug.padEnd(8)} email: analyst@${r.domain}`);
      }
      console.log('\nThe demo identity provider will ask for an email and an organization.');
      console.log('Try analyst@firmx.com against org_firm_y to watch the domain check refuse it.');
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
