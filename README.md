# Commercial Real Estate Deal Analyzer

A powerful, browser-based React application for analyzing and comparing commercial real estate development opportunities. Built to help investors, developers, and real estate professionals evaluate CRE deals with precision and efficiency.

![CRE Deal Analyzer](https://img.shields.io/badge/React-18.2.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## 🚀 Features

### Property Analysis
- **Multiple Property Types**: Car Wash, Multifamily, Office, Retail, and Industrial
- **Construction Scenarios**: Ground-Up Development, Tenant Improvement, and Acquisition/Renovation
- **Comprehensive Financial Metrics**: 
  - Net Operating Income (NOI)
  - Cap Rate
  - Cash-on-Cash Return
  - Debt Service Coverage Ratio (DSCR)
  - Total ROI & Annualized Return
  - Exit Value Projections

### Smart Calculations
- **Automatic Property Tax Rates**: Pre-loaded rates for 20+ cities in Texas and Florida
- **Dynamic Construction Cost Estimates**: Varies by property type and construction method
- **Risk Assessment**: Weighted risk scores based on property type and construction approach
- **Hold Period Projections**: Calculate long-term returns over custom timeframes

### Data Management
- **Local Storage**: Deals persist to browser `localStorage` under a versioned schema with migration. Per-device and per-browser, cleared with site data — a stopgap, not multi-user persistence. The app warns when storage is unavailable or full.
- **Deal Comparison**: Select and compare multiple deals side-by-side
- **CSV Export**: Export all deals for further analysis in Excel or other tools
- **Duplicate & Edit**: Quickly create variations of existing deals

### Dashboard Features
- **Portfolio Overview**: Track total deals, investment amount, average ROI, and total NOI
- **Visual Deal Cards**: Color-coded by property type with key metrics at a glance
- **Bulk Operations**: Edit, duplicate, or delete multiple deals at once

## 📋 Prerequisites

- Node.js (v14 or higher)
- npm or yarn

## 🛠️ Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/cre-deal-analyzer.git
cd cre-deal-analyzer
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm start
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

## 📦 Build for Production

```bash
npm run build
```

This creates an optimized production build in the `build` folder.

## 🎯 Usage

### Creating a New Deal

1. Click the **"New Deal"** button on the dashboard
2. Fill in the deal details:
   - **Basic Info**: Deal name, property type, construction type, location
   - **Financial Details**: Purchase price, construction costs, building size, units
   - **Financing**: Down payment percentage, interest rate, loan term
   - **Operations**: Gross revenue, vacancy rate, operating expense ratio
   - **Exit Strategy**: Exit cap rate, hold period
3. Click **"Save Deal"** to add it to your portfolio

### Property Types Supported

| Property Type | Avg Cap Rate | Construction Cost (Ground-Up) | Icon |
|---------------|--------------|-------------------------------|------|
| **Car Wash** | 7.5% | $250/SF | 🚗 |
| **Multifamily** | 5.5% | $180/SF | 🏠 |
| **Office** | 6.5% | $200/SF | 🏢 |
| **Retail** | 7.0% | $175/SF | 🏪 |
| **Industrial** | 7.5% | $120/SF | 🏭 |

### Construction Types

- **Ground-Up Development**: 18-month timeframe, highest risk (1.4x multiplier)
- **Tenant Improvement**: 6-month timeframe, moderate risk (1.1x multiplier)
- **Acquisition/Renovation**: 12-month timeframe, balanced risk (1.2x multiplier)

### Key Metrics Calculated

All figures are derived from a monthly discrete-period model (`src/lib/finance.js`)
covering the construction/renovation period and the operating hold, terminating in a sale.
No shortcut formulas are layered on top of the schedule.

- **Total Development Cost**: Land + hard cost x contingency + soft cost + capitalized construction interest
- **Stabilized NOI**: Effective gross income less operating expenses, property tax and capital reserves, at stabilized occupancy
- **Yield on Cost**: Stabilized NOI / Total Development Cost
- **Development Spread**: Yield on cost less exit cap rate, in basis points — the metric that decides a ground-up deal
- **Levered / Unlevered IRR**: True IRR solved from dated monthly cash flows by bisection
- **Equity Multiple**: Total distributions / total equity contributed
- **Peak Equity**: Maximum cumulative equity outstanding
- **Stabilized & Minimum DSCR**: NOI / debt service, stabilized and across any rolling operating year
- **Debt Yield**: Stabilized NOI / permanent loan balance
- **Net Sale Proceeds**: Gross sale price less cost of sale less **outstanding** loan balance

The exit is priced off forward 12-month NOI. Revenue, operating expenses and assessed value
escalate over the hold, and lease-up is modelled with an occupancy ramp.

> **Convention**: the Operating Expense Ratio input **excludes property tax**, which the
> engine computes separately from the market's effective rate. A ratio quoted in the market
> usually *includes* taxes — mixing the two double-counts the largest expense line in Texas.

## 🗺️ Property Tax Rates

Pre-loaded property tax rates for:

### Texas Cities
- Houston: 2.81%
- Dallas: 2.42%
- Austin: 2.23%
- San Antonio: 2.34%
- And 6 more Texas cities

### Florida Cities
- Miami: 1.02%
- Orlando: 1.18%
- Tampa: 1.23%
- Jacksonville: 1.15%
- And 6 more Florida cities

*Default rate: 1.5% for unlisted locations*

## 🏗 Architecture

Domain logic lives in `src/lib` and is unit-tested independently of the UI:

| Module | Responsibility |
| --- | --- |
| `finance.js` | Monthly underwriting model, IRR solver, amortization, exit mechanics |
| `propertyTypes.js` | Property and construction type config, program sizing helpers |
| `markets.js` | Market records, tax rate resolution, great-circle distance |
| `marketScore.js` | Explainable market scorecard + ridge-regression weight fitting |
| `siteSelection.js` | Nearby-market discovery and expansion candidates |
| `validation.js` | Covenant and sanity rules, each naming the field it indicts |
| `sensitivity.js` | Two-variable grids, tornado, scenarios, breakeven solver |
| `firmDefaults.js` | Firm-level assumption defaults and override detection |
| `storage.js` | Versioned persistence with schema migration |
| `sampleDeals.js` | First-run sample portfolio |
| `memo.js` | IC memorandum document model — paginated, figure-bound, testable |
| `format.js` | Display formatting; renders unknowns as `n/a`, never `0` |
| `exportCsv.js` | CSV export with honest column names |

The data pipeline lives in `src/pipeline` — see its own
[README](src/pipeline/README.md). Nothing in the application imports it, so it is
not part of the browser bundle.

The interface lives in `src/screens` (Pipeline, Deal Model, Cash Flow, Sensitivity,
Market Intelligence, IC Memo) over shared primitives in `src/ui`.

Run the suite with `CI=true npm test` (360 tests).

## 🖥 Interface

Dark, data-dense, institutional — built to the Nocturne design system from the
wireframe set. Five screens over a fixed icon rail:

- **Pipeline** — ranked ledger with a portfolio line, saved views, and an inline
  cash-flow sparkline per deal. Landing screen for VP / IC.
- **Deal Model** — assumption band across the top, live metric strip, sources & uses,
  capital stack, draw curve, and validation that attaches each warning to the
  offending input. Landing screen for analysts. Form and grid postures.
- **Cash Flow** — frozen line-item column, annual/monthly toggle, construction period
  sunk, stabilization marked by an accent rule, stub periods labelled.
- **Sensitivity** — scenario columns, two-variable grid, tornado, breakeven readouts.
- **Market Intelligence** — ranked markets with a score decomposition drawer.
- **IC Memo** — a six-section memorandum rendered on paper, with an outline rail and page
  thumbnails. Print and Save-as-PDF go through the browser's own print pipeline, so
  pagination is correct and the text stays selectable.

Role determines the landing screen; the switcher in the header changes it.

Two conventions are enforced throughout: every figure uses **tabular numerals** so
columns align, and an unknown renders as `n/a` rather than `0` — a zero and a
missing value are different claims.

## 🧭 Market Intelligence

Markets are scored 0–100 per property type as a linear scorecard over peer-normalized
features — population and employment growth, median income, supply pipeline, rent growth,
tax burden, traffic count, market scale, exit liquidity. Feature directions and weights are
declared explicitly, and every score returns its per-feature contributions: an investment
committee asking *"why 82?"* gets a decomposition, not a black box.

`fitWeights()` re-fits those weights from a firm's own realized deal outcomes by ridge
regression, reporting in-sample R², observation count, and any feature whose realized sign
contradicts its assumed direction. It refuses to fit below 12 observations rather than
returning a confident-looking model built on noise.

### ⚠️ Data provenance

Property tax rates are carried over from the original application. **Every other market
feature is directional seed data** — plausible ordering for development and demos, but not
sourced, not current, and not suitable for underwriting a real deal or presenting to an
investment committee. Each record carries a `provenance` block with a `dataQuality` flag so
the UI can degrade visibly. See the header comment in `src/lib/markets.js` for the
replacement path per feature.

Sample deals are illustrative and internally consistent, not sourced comps.

## 📄 The IC memorandum

The memo is the artifact that leaves the building, so two rules govern it:

1. **Every figure is computed from the live model at generation time.** Nothing is
   transcribed, and each block records the `source` it was bound from. The outline rail
   reports how many figures the document computed, how many assumptions depart from the
   firm set, and how many validation flags are open.
2. **Limitations travel with the document.** The seed-data caveat, the absence of a rent
   roll or promote structure, and the fact that the screening result is a mechanical test
   rather than a recommendation all appear on the memo's own disclosure page — not in a
   caveat someone can forget to repeat.

`screeningVerdict()` reports which of the firm's stated thresholds a deal meets. It is
deliberately not an investment recommendation, and says so on the page.

## 🔗 Data pipeline

`src/pipeline` ingests real market data into the shape the app consumes,
replacing seed values one feature at a time. A **graph** holds entities and
relationships — parcels, owning entities, jurisdictions, geography — and a
**bitemporal fact store** holds observations. That split is deliberate: putting
time series in a graph is how graph projects die.

The graph earns its place on the queries nothing else answers: beneficial
ownership through layers of single-purpose entities, related-party detection for
comparable exclusion, and the overlapping geographic hierarchies that Texas tax
rates come from.

Facts carry two clocks — when a thing was true, and when we learned it — so
`"what did the model see when the committee approved this deal?"` is answerable
after a retroactive assessor correction lands.

Six of nine market features are reachable from public sources (Census ACS, BLS,
county assessors, TxDOT/FDOT). Supply pipeline, market cap rates and rent growth
are licensed-only; they stay seeded and stay flagged, and the default plan still
attempts the licensed source so the gap is reported on every run.

The outbound layer enforces an egress allowlist derived from the plan, redacts
secrets from every log line and error, times out, retries with backoff, breaks
the circuit per host, and issues conditional requests so an unchanged annual roll
costs one 304. The four sources genuinely differ — Census is GET+json, BLS is
POST-with-key, a tax roll is a zip of pipe-delimited text, TxDOT paginates — and
each carries its own request descriptor.

**No request has left the machine.** The transport was built without outbound
network access and is verified against fakes only. The pipeline README has an
ordered first-run sequence.

## 🚧 Known Limitations

- Single-user and browser-local. No authentication, tenancy, roles, or audit trail.
- Construction draws are straight-line rather than S-curve.
- The Market Intelligence map is a plain equirectangular projection, not a real map layer.
- Firm defaults are a static baseline; the shipped product versions them server-side
  with an approval trail.
- No assumptions library or audit log yet — wireframed, not built.
- The memo has no editable prose sections and no firm template picker; it renders from
  the model only.
- No rent roll, lease-level modelling, or tenant rollover.
- No waterfall or promote structure for JV equity.
- Market data is still seed data in the running app: the pipeline exists and is
  tested, but has not yet been run against the live APIs.

## 🔧 Technologies Used

- **React 18.2.0**: Modern UI framework
- **Lucide React**: Beautiful icon library
- **Create React App**: Development environment
- **LocalStorage API**: Client-side data persistence

## 📊 Example Use Cases

1. **Developer**: Compare ground-up vs. acquisition scenarios for the same property type
2. **Investor**: Evaluate multiple deals across different markets and property types
3. **Broker**: Present detailed financial projections to clients
4. **Lender**: Assess deal viability through DSCR and debt service calculations

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- Built with Create React App
- Icons by Lucide React
- Property tax data sourced from municipal tax assessor databases

## 📧 Contact

For questions or feedback, please open an issue on GitHub.

---

**Note**: This application stores all data locally in your browser under the key `cre-deal-analyzer:deals`. No data is sent to external servers. Clearing browser data will delete all saved deals — export to CSV first.
