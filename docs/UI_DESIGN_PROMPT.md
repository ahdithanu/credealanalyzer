# Claude Design Prompt — CRE Deal Analyzer (Enterprise UI)

> Paste everything below the line into Claude (Claude Design, or Claude Code with the
> `/design` skill). Attach a screenshot of the current app if you want an explicit "before".

---

## Role & goal

You are designing the interface for **an institutional commercial real estate underwriting
platform**. The buyer is a Chief Investment Officer, Head of Acquisitions, or CFO at a CRE
investment firm, developer, or family office managing $50M–$2B in assets. The users are
their analysts, VPs, and investment committee.

This is **not** a consumer calculator and it must not look like one. It sits alongside Argus
Enterprise, Dealpath, and CoStar in the user's workflow. If it looks like a Bootstrap
dashboard or a generic SaaS starter template, it fails — an analyst who sees soft shadows
and pastel gradients will not trust the numbers underneath.

Design the full interface. Produce high-fidelity artboards, not wireframes.

## Visual direction: institutional data-dense

Reference points: Bloomberg Terminal's information density (not its color), Argus Enterprise's
tabular rigor, Linear's restraint, a Goldman pitchbook's typographic discipline.

**Density.** Information over whitespace. A VP should see 15–20 deals without scrolling and a
full annual cash flow (10 columns × 15 rows) in one view. Table row height 28–32px. Section
padding 12–16px, not 24–32px. Everything important above the fold.

**Palette.** Near-monochrome, desaturated, low-chroma.
- Canvas `#FAFAFA`, surface `#FFFFFF`, sunken `#F4F4F5`
- Hairline borders `#E4E4E7` — 1px, used everywhere structure is needed
- Text: primary `#18181B`, secondary `#52525B`, tertiary `#A1A1AA`
- One accent only, used sparingly for interactive affordance: `#1D4ED8`
- Semantic, muted not neon: positive `#15803D`, negative `#B91C1C`, caution `#B45309`
- **No gradients. No glassmorphism. No drop shadows on cards.** Separate regions with 1px
  rules and background tone shifts, never elevation. Shadow is permitted only on genuinely
  floating layers (dropdown, modal, tooltip).
- Color carries meaning or it isn't used. Never decorate with it. The current app color-codes
  property types with purple/green/blue/red/orange — replace that with a small neutral type
  glyph plus a text label, and reserve color for performance signal only.

**Typography.**
- UI: Inter or IBM Plex Sans. 13px body, 12px in tables, 11px uppercase +0.05em tracking for
  column headers and section labels.
- **All numerals are tabular.** `font-variant-numeric: tabular-nums` is mandatory on every
  figure so digits align in columns. Use IBM Plex Mono or JetBrains Mono for dense financial
  grids.
- Financial number conventions, non-negotiable:
  - Right-align every numeric cell
  - Negatives in parentheses and red: `(1,240,500)`
  - Units live in the column header, not repeated in each cell
  - Large currency abbreviated in tables (`$12.4M`, `$840K`), full precision on detail/hover
  - Percentages to 1–2 decimals consistently; basis points as integers (`+185 bps`)
  - Never render a bare `NaN`, `Infinity`, or `—` without explanation; show `n/a` with a
    tooltip stating why (e.g. "IRR undefined: no sign change in cash flows")

**Chrome.** Fixed left sidebar nav (~220px, collapsible to 56px icon rail). Persistent top bar
carrying deal context (name, address, stage chip, last-modified-by) and primary actions.
Content area scrolls independently. No hero sections. No marketing language anywhere.

## Information architecture — role-split landing

The app has role-aware entry. Design both landings.

- **Analyst** lands on the **Deal Model** — the underwriting workspace. Optimized for fast
  iteration on assumptions.
- **VP / Investment Committee** lands on the **Pipeline** — ranked deals, comparison, approval.
  Optimized for judgment, not data entry.
- A role switcher exists in the user menu (also used for demos).

Sidebar: Pipeline · Deal Model · Cash Flow · Sensitivity · Market Intelligence · IC Memo ·
Assumptions Library · Audit Log.

## Screens to design

### 1. Pipeline (VP/IC default)
Dense sortable table, one row per deal. Columns: Deal · Type · Market · Stage · Total Dev Cost ·
Equity · Levered IRR · Equity Multiple · Yield on Cost · Dev Spread (bps) · Stabilized DSCR ·
Owner · Updated. Inline sparkline for cash flow shape. Multi-select for comparison. Saved
filter views ("Under LOI", "IC Thursday", "Texas ground-up"). Stage chips are text + hairline
border, not filled pills. Above the table, a thin portfolio strip: total equity deployed,
weighted-avg IRR, count by stage — small type, no giant metric cards.

### 2. Deal Model (Analyst default) — the hero screen
Three-pane layout:
- **Left (~320px):** assumption inputs, grouped in collapsible sections — Site & Program,
  Development Budget, Revenue, Operating Expenses, Financing, Exit. Every input is a compact
  labeled field with unit suffix. Show which values are firm defaults vs. analyst overrides
  (an override gets a small marker and a "reset to firm default" affordance). This is the
  governance story — make it visible.
- **Center:** live output. Top row of key returns as a tight horizontal metric strip (not
  cards): Levered IRR · Unlevered IRR · Equity Multiple · Peak Equity · Yield on Cost ·
  Dev Spread · Stabilized DSCR · Debt Yield. Below it, the sources & uses table and an
  equity/debt draw curve over the construction period.
- **Right (~280px, collapsible):** validation and warnings panel — DSCR below covenant,
  negative dev spread, exit cap tighter than entry, lease-up beyond market absorption. Each
  warning names the offending assumption and links to it.

Recalculation is instant on input change. Show the changed metric with a brief directional
delta (`▲ +42 bps`) rather than animating the whole panel.

### 3. Cash Flow
Full monthly and annual toggle. Frozen first column (line item), horizontally scrolling
periods, frozen header row. Line items: Gross Potential Revenue, Vacancy/Absorption Loss,
Effective Gross Income, Operating Expenses (expandable to fixed/variable), Property Tax,
Capital Reserves, **NOI**, Debt Service, **Cash Flow**, Cumulative Cash Flow. Subtotal rows
get a top hairline rule and medium weight — not a filled background. Construction period
columns are visually distinguished (sunken background tone), with the stabilization month
marked by a vertical rule.

### 4. Sensitivity & Scenarios
- Two-variable sensitivity grid (exit cap × interest rate, cost overrun × rent growth) with a
  restrained sequential fill — light neutral to accent, not red-yellow-green heatmap.
- Tornado chart ranking assumption impact on levered IRR.
- Side-by-side scenario columns (Base / Downside / Upside) with per-line variance.
- Breakeven readouts: occupancy, exit cap, rent to hit target IRR and 1.25x DSCR.

### 5. Market Intelligence & Site Selection
This is the differentiating screen. Split view:
- **Left:** map with markets/submarkets as scored points, radius filter from the subject deal.
- **Right:** ranked candidate markets table — Market · Opportunity Score (0–100) · Population
  Growth · Employment Growth · Median HHI · Supply Pipeline · Effective Tax Rate · Market Cap
  Rate · Distance.
- Selecting a market opens an **explainability panel**: a horizontal contribution bar chart
  showing exactly which features drove the score up or down, with each feature's value, the
  peer-set percentile, and the model weight. Enterprise buyers will not accept a black-box
  score — the "why" must be first-class UI, not a tooltip.
- Include a visible **data provenance line** per market (source + as-of date) and a clear
  state for stale or missing data.
- Include a "model" affordance showing whether scoring uses the default weights or weights
  learned from the firm's own realized deal outcomes.

### 6. IC Memo
Print/PDF-oriented layout preview at page width: deal summary, returns table, cash flow
summary, sensitivity exhibit, market context, assumption appendix. Firm logo lockup. This is
the artifact that leaves the building — make it look like a document, not a webpage.

### 7. Assumptions Library & 8. Audit Log
Library: firm-level default assumption sets, versioned, by property type and market.
Audit: chronological ledger — actor, timestamp, deal, field, old value → new value. Dense,
monospaced, filterable. This is the compliance story.

## States to include
Empty pipeline · single-deal empty model · loading skeletons (hairline, not shimmer) ·
validation errors on inputs · an undefined-IRR deal · a deal with stale market data ·
permission-denied view for a read-only IC member.

## Explicitly avoid
Rounded-2xl cards floating on gray · emoji or 3D illustrations · purple/indigo gradient
accents · giant KPI tiles with 48px numbers · centered marketing copy · pill-shaped filled
buttons · icon-only actions without labels · animated counters · any chart with a rainbow
categorical palette · proportional (non-tabular) figures in a table.

## Deliverable
Artboards at 1440×1024 for each screen above, plus a compact style-token board (color ramp,
type scale, numeric conventions, table anatomy, form control anatomy, chip and button states).
Design light theme first; note the dark-theme token mapping.
