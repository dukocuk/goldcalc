# Project Index: goldcalc

> Compact map of the repo. Read this first instead of re-scanning source.
> Regenerate with `/sc:index-repo` when structure changes.

## Overview

**goldcalc** ("Guld eller markup?") is a Danish-language single-page web app that tells
you whether a gold purchase is a good deal. You enter price, weight, and karat; it fetches
the live spot price and shows your real price per gram of pure gold and how far over spot
you are paying. The entire app is **one React component** plus scaffolding.

**Stack:** React 18 · Vite 5 · plain inline-style UI (no CSS framework) · deployed to GitHub Pages.

## Project Structure

```
goldcalc/
├── index.html                    Vite HTML entry (#root, lang="da")
├── vite.config.js                base path + React plugin
├── package.json                  scripts + deps
├── src/
│   ├── main.jsx                  React root, mounts the app
│   └── GoldValueCalculator.jsx   the whole app (UI + logic + data fetch)
└── .github/workflows/
    └── deploy.yml                build & deploy to GitHub Pages
```

## Entry Points

`index.html` → loads `/src/main.jsx` → renders `<GoldValueCalculator/>` in `<React.StrictMode>`.

## Core Module — `src/GoldValueCalculator.jsx`

Single file containing all logic and presentation.

**Constants / data**
- `T` — design tokens (colors, font stacks) matching a printed "feltkort" look
- `OZ = 31.1035` — grams per troy ounce
- `KARATS` — karat→purity table (24k…8k)

**Pure helpers**
- `num(s)` — parse Danish-style input (comma decimals, dot thousands) → number
- `kr / krg / g / pct` — Danish-locale formatters (kr, kr/g, grams, signed %)
- `verdictFor(overSpot)` — grades premium over spot: Under spot / Fremragende / OK / For dyrt
- `compute({spot, price, gram, purity})` — core math: pure-gold weight, gold value,
  price per gram of pure gold, % over spot, premium over gold value

**Data fetch**
- `fetchSpotDKKperGram()` — spot price in DKK/gram of pure gold; combines
  gold price (USD/oz) with USD→DKK FX. Both endpoints are CORS-open, so no proxy.

**Components**
- `GoldValueCalculator` (default export) — state, spot auto-load, inputs, result card,
  save-to-compare list (sorted by best price/g)
- `Metric` — small presentational tile used in the result grid

## External APIs

- **Spot:** `https://api.gold-api.com/price/XAU` → `price` (USD per troy oz)
- **FX:** `https://open.er-api.com/v6/latest/USD` → `rates.DKK`
- Both send `Access-Control-Allow-Origin: *` (chosen over goldprice.org, which blocks
  datacenter IPs). On fetch failure the spot field falls back to manual entry.

## Configuration

- **`vite.config.js`** — `base: "/goldcalc/"` (GitHub Pages subpath), `@vitejs/plugin-react`
- **`.github/workflows/deploy.yml`** — on push to `master` (or manual dispatch): `npm ci`
  → `npm run build` → upload `dist/` → deploy to GitHub Pages
- **npm scripts** — `dev` (vite dev server) · `build` (vite build) · `preview` (serve build)

## Quick Start

```bash
npm install
npm run dev        # local dev server
npm run build      # production build → dist/
npm run preview    # preview the production build
```
