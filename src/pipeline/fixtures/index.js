/**
 * Fixtures shaped like the real payloads, including their annoyances:
 * string-typed numbers, suppressed cells as negative sentinels, BLS M13 annual
 * averages, and the same legal entity spelled three ways across two counties.
 */

export const censusACS = [
  ['NAME', 'B01003_001E', 'B19013_001E', 'B25077_001E', 'B23025_004E', 'metropolitan statistical area/micropolitan statistical area'],
  ['Houston-The Woodlands-Sugar Land, TX Metro Area', '7340118', '72004', '268300', '3512400', '26420'],
  ['Dallas-Fort Worth-Arlington, TX Metro Area', '7943685', '78000', '312100', '4021880', '19100'],
  ['Austin-Round Rock-Georgetown, TX Metro Area', '2473275', '91000', '432700', '1310220', '12420'],
  // A suppressed median-income cell, as ACS actually encodes it.
  ['Corpus Christi, TX Metro Area', '444258', '-666666666', '198400', '198110', '18580'],
];

export const censusACSPrior = [
  ['NAME', 'B01003_001E', 'metropolitan statistical area/micropolitan statistical area'],
  ['Houston-The Woodlands-Sugar Land, TX Metro Area', '6665238', '26420'],
  ['Dallas-Fort Worth-Arlington, TX Metro Area', '7102796', '19100'],
  ['Austin-Round Rock-Georgetown, TX Metro Area', '2115827', '12420'],
  ['Corpus Christi, TX Metro Area', '442600', '18580'],
];

export const blsCES = {
  status: 'REQUEST_SUCCEEDED',
  Results: {
    series: [{
      seriesID: 'SMU48264200000000001',
      data: [
        { year: '2026', period: 'M13', periodName: 'Annual', value: '3450.0' },  // must be ignored
        { year: '2026', period: 'M06', periodName: 'June', value: '3489.2' },
        { year: '2025', period: 'M06', periodName: 'June', value: '3407.1' },
        { year: '2024', period: 'M06', periodName: 'June', value: '3330.5' },
      ],
    }],
  },
};

export const blsFailure = {
  status: 'REQUEST_NOT_PROCESSED',
  message: ['No Data Available for Series SMU48000000000000001'],
};

export const hcadRoll = [
  { acct: '0001234567', owner_name: 'SUNBELT CAR WASH HOLDINGS LLC', owner_addr: '1200 COMMERCE ST STE 400', site_addr: '8801 KATY FWY', tot_appr_val: '2145000', tax_yr: '2025', tot_tax_rate: '2.81', lat: '29.7845', lon: '-95.4612' },
  { acct: '0001234568', owner_name: 'Sunbelt Car Wash Holdings, L.L.C.', owner_addr: '1200 Commerce Street, Suite 400', site_addr: '4400 WESTHEIMER RD', tot_appr_val: '3310000', tax_yr: '2025', tot_tax_rate: '2.81', lat: '29.7360', lon: '-95.4810' },
  { acct: '0001234569', owner_name: 'KATY FREEWAY LOGISTICS PARTNERS LP', owner_addr: '900 TOWN & COUNTRY LN', site_addr: '15900 PARK ROW', tot_appr_val: '41200000', tax_yr: '2025', tot_tax_rate: '2.81', lat: '29.7830', lon: '-95.6420' },
];

export const dcadRoll = [
  { ACCOUNT_NUM: '00000700123400000', OWNER_NAME1: 'SUNBELT CAR WASH HLDGS LLC', OWNER_ADDRESS: '1200 COMMERCE ST STE 400', SITE_ADDRESS: '5600 GREENVILLE AVE', TOT_VAL: '2890000', TAX_YEAR: '2025', TOTAL_RATE: '2.42', LATITUDE: '32.8620', LONGITUDE: '-96.7700' },
  { ACCOUNT_NUM: '00000700123500000', OWNER_NAME1: 'PLANO NORTH CAMPUS OWNER LLC', OWNER_ADDRESS: '3232 MCKINNEY AVE', SITE_ADDRESS: '6900 LEGACY DR', TOT_VAL: '28400000', TAX_YEAR: '2025', TOTAL_RATE: '2.15', LATITUDE: '33.0760', LONGITUDE: '-96.8210' },
];

/**
 * The HCAD roll as it actually arrives: pipe-delimited text inside a zip.
 * Built from `hcadRoll` so the two cannot drift apart.
 */
export const hcadDelimitedText = (() => {
  const cols = Object.keys(hcadRoll[0]);
  return [cols.join('|'), ...hcadRoll.map((r) => cols.map((c) => r[c]).join('|'))].join('\n');
})();

/**
 * Stands in for a real archive: the bytes a zip download would produce.
 * Encoded by hand rather than with TextEncoder, which jsdom does not provide.
 */
export const hcadZipBytes = (() => {
  const bytes = new Uint8Array(hcadDelimitedText.length);
  for (let i = 0; i < hcadDelimitedText.length; i++) bytes[i] = hcadDelimitedText.charCodeAt(i) & 0xff;
  return bytes.buffer;
})();

/** A fake unpacker. Production injects one backed by a real zip reader. */
export const fakeUnpackArchive = async ({ buffer }) =>
  String.fromCharCode(...new Uint8Array(buffer));

export const txdotAADT = {
  features: [
    { attributes: { STATION_ID: 'TX-0451', AADT_RPT_QTY: 42000, YEAR: 2025, LAT: 29.7840, LON: -95.4600 } },
    { attributes: { STATION_ID: 'TX-0452', AADT_RPT_QTY: 48000, YEAR: 2025, LAT: 32.8600, LON: -96.7700 } },
    { attributes: { STATION_ID: 'TX-0453', AADT_RPT_QTY: null, YEAR: 2025, LAT: 30.2670, LON: -97.7430 } },
  ],
};

/** Maps a Census CBSA geography id to the app's market key. */
export const CBSA_TO_MARKET = {
  26420: 'houston-tx',
  19100: 'dallas-tx',
  12420: 'austin-tx',
  18580: 'corpus-christi-tx',
};

/** A fetchImpl that serves fixtures, for testing the client without a network. */
export function fixtureFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
    const r = routes[key];
    if (typeof r === 'function') return r(url);
    if (r && r.binary) {
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => r.binary,
        text: async () => { throw new Error('binary payload read as text'); },
      };
    }
    const body = JSON.stringify(r);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body, json: async () => r };
  };
}
