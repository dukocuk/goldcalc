// Pure calculation logic for the gold value calculator.
// No DOM, no React — everything here is unit-testable in isolation.

export const OZ = 31.1035; // gram per troy ounce

export const KARATS = [
  { k: "24k", purity: 1.0 },
  { k: "22k", purity: 0.916 },
  { k: "21k", purity: 0.875 },
  { k: "18k", purity: 0.75 },
  { k: "14k", purity: 0.585 },
  { k: "9k", purity: 0.375 },
  { k: "8k", purity: 0.333 },
];

export const CURRENCIES = [
  { code: "DKK", unit: "kr" },
  { code: "TRY", unit: "₺" },
  { code: "EUR", unit: "€" },
  { code: "USD", unit: "$" },
];
export const unitFor = (code) => (CURRENCIES.find((c) => c.code === code) || CURRENCIES[0]).unit;

// parse Danish-style input (comma decimals, dot thousands).
// A lone dot is only a thousands separator when it groups exactly 3 digits
// ("8.800" → 8800); otherwise it's a decimal point ("8.8" → 8.8).
export const num = (s) => {
  if (s === "" || s == null) return NaN;
  let t = String(s).trim();
  if (t.includes(",")) {
    t = t.replace(/\./g, "").replace(",", ".");
  } else if ((t.match(/\./g) || []).length > 1 || /^\d{1,3}(\.\d{3})+$/.test(t)) {
    t = t.replace(/\./g, "");
  }
  const v = parseFloat(t);
  return isNaN(v) ? NaN : v;
};
export const money = (v, unit) =>
  isFinite(v) ? v.toLocaleString("da-DK", { maximumFractionDigits: 0 }) + " " + unit : "—";
export const moneyPerG = (v, unit) =>
  isFinite(v) ? v.toLocaleString("da-DK", { maximumFractionDigits: 0 }) + " " + unit + "/g" : "—";
export const g = (v) =>
  isFinite(v) ? v.toLocaleString("da-DK", { maximumFractionDigits: 2 }) + " g" : "—";
export const pct = (v) =>
  isFinite(v)
    ? (v >= 0 ? "+" : "−") +
      Math.abs(v).toLocaleString("da-DK", { maximumFractionDigits: 0 }) + " %"
    : "—";

// tone is a semantic key ("good" | "ok" | "bad") — the UI maps it to a color.
export function verdictFor(p) {
  if (!isFinite(p)) return null;
  if (p < 0) return { label: "Under spot", sub: "Tjek at prisen er dagsaktuel", tone: "good" };
  if (p <= 10) return { label: "Fremragende", sub: "Reelt investeringsguld", tone: "good" };
  if (p <= 25) return { label: "OK", sub: "Hvis du også vil bære det", tone: "ok" };
  return { label: "For dyrt", sub: "Du betaler for smykke, ikke guld", tone: "bad" };
}

export function compute({ spot, price, gram, purity, spread }) {
  const s = num(spot), p = num(price), w = num(gram);
  if (![s, p, w].every(isFinite) || w <= 0 || p <= 0 || s <= 0) return null;
  const pure = w * purity;
  const goldValue = pure * s;
  const pricePerG = p / pure;
  const overSpot = (pricePerG / s - 1) * 100;
  const premium = p - goldValue;
  // break-even: the spot price at which selling back at spot × (1 − spread)
  // recoups the price paid. Blank/negative/≥100% spread leaves these undefined.
  let breakEvenSpot, breakEvenDelta;
  const spreadFrac = num(spread) / 100;
  if (isFinite(spreadFrac) && spreadFrac >= 0 && spreadFrac < 1) {
    breakEvenSpot = pricePerG / (1 - spreadFrac);
    breakEvenDelta = (breakEvenSpot / s - 1) * 100;
  }
  return { pure, goldValue, pricePerG, overSpot, premium, breakEvenSpot, breakEvenDelta };
}

// spot per gram in a currency; keep decimals when the number is small
// (EUR/USD grams ~100) so integer rounding doesn't cost half a percent.
export const spotInCurrency = ({ ozUsd, rates }, code) => {
  const rate = rates?.[code];
  if (!(ozUsd > 0 && rate > 0)) return NaN;
  const v = (ozUsd / OZ) * rate;
  return v >= 300 ? Math.round(v) : Math.round(v * 100) / 100;
};
