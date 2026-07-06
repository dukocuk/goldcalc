import { useState, useMemo, useEffect, useCallback, useRef } from "react";

// ---- design tokens (matches the printed feltkort) ----
// Colors live in CSS custom properties (see CSS below) so the palette can
// switch with prefers-color-scheme; T just references the variables.
const T = {
  paper: "var(--paper)",
  card: "var(--card)",
  ink: "var(--ink)",
  inkSoft: "var(--ink-soft)",
  line: "var(--line)",
  lineSoft: "var(--line-soft)",
  gold: "var(--gold)",
  goldBg: "var(--gold-bg)",
  good: "var(--good)",
  ok: "var(--ok)",
  bad: "var(--bad)",
  mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
  serif: 'Georgia,"Times New Roman",serif',
  sans: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif',
};

// Palette + pseudo-states (hover/focus) that inline styles can't express.
const CSS = `
:root {
  --paper:#FBFAF6; --card:#FFFFFF; --ink:#1C1B18; --ink-soft:#5A574E;
  --line:#DED8CA; --line-soft:#EBE7DC; --gold:#A67C1A; --gold-bg:#F6EFDC;
  --good:#3F7A5A; --ok:#8A6D1E; --bad:#A6483C;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper:#14130F; --card:#1E1C17; --ink:#EDEAE0; --ink-soft:#A39F92;
    --line:#3A362C; --line-soft:#2A2721; --gold:#D4A72C; --gold-bg:#2E2712;
    --good:#6FBF94; --ok:#C9A84C; --bad:#D97B6C;
  }
}
input:focus-visible, button:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.link-btn:hover { color: var(--ink); }
.karat-btn:hover { border-color: var(--gold); }
.save-btn:not(:disabled):hover { opacity: .88; }
.save-btn:not(:disabled):active { transform: translateY(1px); }
.remove-btn:hover { color: var(--bad); }
@media (max-width: 380px) {
  .metric-grid { grid-template-columns: 1fr !important; }
  .input-grid { grid-template-columns: 1fr !important; }
}
`;

const OZ = 31.1035; // gram per troy ounce

const KARATS = [
  { k: "24k", purity: 1.0 },
  { k: "22k", purity: 0.916 },
  { k: "21k", purity: 0.875 },
  { k: "18k", purity: 0.75 },
  { k: "14k", purity: 0.585 },
  { k: "9k", purity: 0.375 },
  { k: "8k", purity: 0.333 },
];

const CURRENCIES = [
  { code: "DKK", unit: "kr" },
  { code: "TRY", unit: "₺" },
  { code: "EUR", unit: "€" },
  { code: "USD", unit: "$" },
];
const unitFor = (code) => (CURRENCIES.find((c) => c.code === code) || CURRENCIES[0]).unit;

// parse Danish-style input (comma decimals, dot thousands).
// A lone dot is only a thousands separator when it groups exactly 3 digits
// ("8.800" → 8800); otherwise it's a decimal point ("8.8" → 8.8).
const num = (s) => {
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
const money = (v, unit) =>
  isFinite(v) ? v.toLocaleString("da-DK", { maximumFractionDigits: 0 }) + " " + unit : "—";
const moneyPerG = (v, unit) =>
  isFinite(v) ? v.toLocaleString("da-DK", { maximumFractionDigits: 0 }) + " " + unit + "/g" : "—";
const g = (v) =>
  isFinite(v) ? v.toLocaleString("da-DK", { maximumFractionDigits: 2 }) + " g" : "—";
const pct = (v) =>
  isFinite(v)
    ? (v >= 0 ? "+" : "−") +
      Math.abs(v).toLocaleString("da-DK", { maximumFractionDigits: 0 }) + " %"
    : "—";

function verdictFor(p) {
  if (!isFinite(p)) return null;
  if (p < 0) return { label: "Under spot", sub: "Tjek at prisen er dagsaktuel", color: T.good };
  if (p <= 10) return { label: "Fremragende", sub: "Reelt investeringsguld", color: T.good };
  if (p <= 25) return { label: "OK", sub: "Hvis du også vil bære det", color: T.ok };
  return { label: "For dyrt", sub: "Du betaler for smykke, ikke guld", color: T.bad };
}

function compute({ spot, price, gram, purity, spread }) {
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

// ---- live spot fetch (per gram of pure gold, any currency) ----
// api.gold-api.com returns Access-Control-Allow-Origin: * so no proxy is needed
// in dev or prod (unlike goldprice.org, which blocks non-browser/datacenter IPs).
// The FX endpoint returns all rates against USD in one call, so currency
// switching reuses the raw data without refetching.
async function fetchSpotData() {
  const signal = AbortSignal.timeout(8000); // don't hang forever on a dead API
  const [gr, fr] = await Promise.all([
    fetch("https://api.gold-api.com/price/XAU", { cache: "no-store", signal }),
    fetch("https://open.er-api.com/v6/latest/USD", { cache: "no-store", signal }),
  ]);
  const gold = await gr.json();
  const fx = await fr.json();
  const ozUsd = gold?.price;
  const rates = fx?.rates;
  if (ozUsd > 0 && rates && typeof rates === "object")
    return { ozUsd, rates, source: "gold-api.com + FX" };
  throw new Error("no-source");
}

// spot per gram in a currency; keep decimals when the number is small
// (EUR/USD grams ~100) so integer rounding doesn't cost half a percent.
const spotInCurrency = ({ ozUsd, rates }, code) => {
  const rate = rates?.[code];
  if (!(ozUsd > 0 && rate > 0)) return NaN;
  const v = (ozUsd / OZ) * rate;
  return v >= 300 ? Math.round(v) : Math.round(v * 100) / 100;
};

// ---- comparison-list persistence ----
const LS_KEY = "goldcalc.list";
const CUR_KEY = "goldcalc.currency";
const loadList = () => {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export default function GoldValueCalculator() {
  const [spot, setSpot] = useState("");
  const [spotStatus, setSpotStatus] = useState("loading"); // loading | live | manual | error
  const [spotMeta, setSpotMeta] = useState({ time: "", source: "" });
  const [spotRaw, setSpotRaw] = useState(null); // { ozUsd, rates } from last successful fetch
  const [price, setPrice] = useState("");
  const [gram, setGram] = useState("");
  const [karat, setKarat] = useState("22k");
  const [spread, setSpread] = useState("10");
  const [currency, setCurrency] = useState(() => {
    try {
      const c = localStorage.getItem(CUR_KEY);
      return CURRENCIES.some((x) => x.code === c) ? c : "DKK";
    } catch {
      return "DKK";
    }
  });
  const [list, setList] = useState(loadList);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage full/blocked */ }
  }, [list]);

  useEffect(() => {
    try { localStorage.setItem(CUR_KEY, currency); } catch { /* storage full/blocked */ }
  }, [currency]);

  // loadSpot reads currency via a ref so the mount effect doesn't refetch on
  // every currency switch — switching converts locally from spotRaw instead.
  const currencyRef = useRef(currency);
  useEffect(() => { currencyRef.current = currency; }, [currency]);

  const loadSpot = useCallback(async () => {
    setSpotStatus("loading");
    try {
      const raw = await fetchSpotData();
      const value = spotInCurrency(raw, currencyRef.current);
      if (!isFinite(value)) throw new Error("no-rate");
      setSpotRaw(raw);
      setSpot(String(value).replace(".", ","));
      setSpotMeta({
        time: new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" }),
        source: raw.source,
      });
      setSpotStatus("live");
    } catch {
      setSpotStatus("error");
    }
  }, []);

  useEffect(() => { loadSpot(); }, [loadSpot]);

  const changeCurrency = (next) => {
    if (next === currency) return;
    const rates = spotRaw?.rates;
    if (spotStatus === "live" && spotRaw && rates?.[next] > 0) {
      setSpot(String(spotInCurrency(spotRaw, next)).replace(".", ","));
    } else {
      // manual/error: convert the typed value if we have rates, else keep it
      const v = num(spot);
      if (isFinite(v) && rates?.[next] > 0 && rates?.[currency] > 0) {
        const converted = (v * rates[next]) / rates[currency];
        const rounded = converted >= 300 ? Math.round(converted) : Math.round(converted * 100) / 100;
        setSpot(String(rounded).replace(".", ","));
      }
    }
    setCurrency(next);
  };

  const purity = KARATS.find((x) => x.k === karat).purity;
  const r = useMemo(() => compute({ spot, price, gram, purity, spread }), [spot, price, gram, purity, spread]);
  const v = r ? verdictFor(r.overSpot) : null;
  const unit = unitFor(currency);
  // best-buy only competes within the active currency — raw numbers across
  // currencies aren't comparable.
  const sameCur = list.filter((x) => (x.currency || "DKK") === currency);
  const bestG = sameCur.length ? Math.min(...sameCur.map((x) => x.pricePerG)) : Infinity;
  const mixedCur = list.some((x) => (x.currency || "DKK") !== currency);

  const add = () => {
    if (!r) return;
    setList((l) => [{ id: Date.now(), karat, gram: num(gram), price: num(price), spotAtSave: num(spot), spreadAtSave: num(spread), currency, ...r }, ...l]);
  };

  const S = {
    label: { fontFamily: T.mono, fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: T.inkSoft, marginBottom: 6, display: "block" },
    input: { width: "100%", fontFamily: T.mono, fontSize: 17, color: T.ink, background: T.card, border: `1px solid ${T.line}`, borderRadius: 6, padding: "11px 12px", outline: "none" },
    suffix: { position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontFamily: T.mono, fontSize: 13, color: T.inkSoft, pointerEvents: "none" },
  };

  // spot status chip
  const spotTag = () => {
    if (spotStatus === "loading") return { text: "Henter dagens pris…", color: T.inkSoft };
    if (spotStatus === "live") return { text: `Live · ${spotMeta.source} · ${spotMeta.time}`, color: T.good };
    if (spotStatus === "manual") return { text: "Manuelt indtastet", color: T.ok };
    return { text: "Kunne ikke hente — indtast selv", color: T.bad };
  };
  const tag = spotTag();

  return (
    <div style={{ background: T.paper, minHeight: "100%", fontFamily: T.sans, color: T.ink, padding: "24px 16px 56px" }}>
      <style>{CSS}</style>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>

        <div style={{ borderBottom: `2px solid ${T.ink}`, paddingBottom: 16, marginBottom: 22 }}>
          <div style={{ fontFamily: T.mono, fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase", color: T.gold, marginBottom: 8 }}>
            Guldkøb · beregner
          </div>
          <h1 style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 30, lineHeight: 1.1, margin: 0, letterSpacing: "-.01em" }}>
            Guld eller markup?
          </h1>
          <p style={{ color: T.inkSoft, fontSize: 14.5, margin: "10px 0 0", maxWidth: "44ch" }}>
            Spotprisen hentes automatisk. Tast pris, vægt og karat — så ser du din reelle pris per gram rent guld, hvor langt over spot du betaler, og hvad spot skal stige til, før du kan sælge tilbage uden tab.
          </p>
        </div>

        {/* SPOT — auto */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <label htmlFor="spot-input" style={{ ...S.label, marginBottom: 0 }}>Spotpris (auto)</label>
            <button
              className="link-btn"
              onClick={loadSpot}
              disabled={spotStatus === "loading"}
              style={{ background: "none", border: "none", cursor: spotStatus === "loading" ? "default" : "pointer", fontFamily: T.mono, fontSize: 12, color: T.gold, textDecoration: "underline", padding: 0 }}
            >
              {spotStatus === "loading" ? "…" : "Opdater"}
            </button>
          </div>
          <div role="group" aria-label="Valuta" style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {CURRENCIES.map((c) => {
              const on = c.code === currency;
              return (
                <button key={c.code} className="karat-btn" aria-pressed={on} onClick={() => changeCurrency(c.code)}
                  style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: "6px 10px", borderRadius: 5, border: `1px solid ${on ? T.gold : T.line}`, background: on ? T.goldBg : T.card, color: on ? T.gold : T.inkSoft }}>
                  {c.code}
                </button>
              );
            })}
          </div>
          <div style={{ position: "relative" }}>
            <input
              id="spot-input"
              style={{ ...S.input, borderColor: spotStatus === "live" ? T.good : spotStatus === "error" ? T.bad : T.line }}
              inputMode="decimal"
              value={spot}
              onChange={(e) => { setSpot(e.target.value); setSpotStatus("manual"); }}
              placeholder={spotStatus === "loading" ? "…" : "fx 875"}
            />
            <span style={S.suffix}>{unit} / gram</span>
          </div>
          <div aria-live="polite" style={{ fontFamily: T.mono, fontSize: 11.5, color: tag.color, marginTop: 6 }}>
            {tag.text}
            {spotStatus === "live" && <span style={{ color: T.inkSoft }}> · ren spot, dealer-gram ligger typisk lidt over</span>}
          </div>
        </div>

        {/* inputs */}
        <div className="input-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{ position: "relative" }}>
            <label htmlFor="price-input" style={S.label}>Pris</label>
            <div style={{ position: "relative" }}>
              <input id="price-input" style={S.input} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="8.800" />
              <span style={S.suffix}>{unit}</span>
            </div>
          </div>
          <div style={{ position: "relative" }}>
            <label htmlFor="gram-input" style={S.label}>Vægt</label>
            <div style={{ position: "relative" }}>
              <input id="gram-input" style={S.input} inputMode="decimal" value={gram} onChange={(e) => setGram(e.target.value)} placeholder="12" />
              <span style={S.suffix}>g</span>
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={S.label} id="karat-label">Karat</label>
            <div role="group" aria-labelledby="karat-label" style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {KARATS.map((x) => {
                const on = x.k === karat;
                return (
                  <button key={x.k} className="karat-btn" aria-pressed={on} onClick={() => setKarat(x.k)}
                    style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "8px 12px", borderRadius: 5, border: `1px solid ${on ? T.gold : T.line}`, background: on ? T.goldBg : T.card, color: on ? T.gold : T.inkSoft }}>
                    {x.k}
                    <span style={{ fontSize: 10.5, color: T.inkSoft, marginLeft: 5, fontWeight: 400 }}>
                      {(x.purity * 100).toLocaleString("da-DK", { maximumFractionDigits: 1 })}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="spread-input" style={S.label}>Spread ved tilbagesalg</label>
            <div style={{ position: "relative" }}>
              <input id="spread-input" style={S.input} inputMode="decimal" value={spread} onChange={(e) => setSpread(e.target.value)} placeholder="10" />
              <span style={S.suffix}>%</span>
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.inkSoft, marginTop: 6 }}>
              Rabat en opkøber typisk trækker fra spot ved tilbagekøb — bruges til break-even.
            </div>
          </div>
        </div>

        {/* result */}
        <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 8, marginTop: 22, overflow: "hidden" }}>
          <div style={{ padding: "16px 18px", background: v ? T.goldBg : T.lineSoft, borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div>
              <div style={{ fontFamily: T.serif, fontSize: 20, fontWeight: 600, color: v ? v.color : T.inkSoft }}>
                {v ? v.label : "Afventer input"}
              </div>
              <div style={{ fontSize: 13, color: T.inkSoft, marginTop: 2 }}>
                {v ? v.sub : "Udfyld pris, vægt og karat"}
              </div>
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 600, color: v ? v.color : T.inkSoft, whiteSpace: "nowrap" }}>
              {r ? pct(r.overSpot) : "—"}
            </div>
          </div>
          <div className="metric-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
            <Metric label="Din guldpris" value={r ? moneyPerG(r.pricePerG, unit) : "—"} big accent />
            <Metric label="Spot-gulv" value={isFinite(num(spot)) ? moneyPerG(num(spot), unit) : "—"} big />
            <Metric label="Rent guld i stykket" value={r ? g(r.pure) : "—"} />
            <Metric label="Guldværdi ved spot" value={r ? money(r.goldValue, unit) : "—"} />
            <Metric label="Merpris over guldværdi" value={r ? (r.premium >= 0 ? "+" : "−") + money(Math.abs(r.premium), unit) : "—"} span />
            <Metric label="Break-even spotpris" value={r && isFinite(r.breakEvenSpot) ? moneyPerG(r.breakEvenSpot, unit) : "—"} />
            <Metric label="Afstand til break-even" value={r && isFinite(r.breakEvenDelta) ? pct(r.breakEvenDelta) : "—"} />
          </div>
        </div>

        <button className="save-btn" onClick={add} disabled={!r}
          style={{ width: "100%", marginTop: 12, padding: "13px", borderRadius: 6, cursor: r ? "pointer" : "not-allowed", fontFamily: T.sans, fontSize: 15, fontWeight: 600, border: `1px solid ${r ? T.ink : T.line}`, background: r ? T.ink : T.card, color: r ? T.paper : T.inkSoft }}>
          Gem til sammenligning
        </button>

        {list.length > 0 && (
          <div style={{ marginTop: 26 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <div style={{ fontFamily: T.serif, fontSize: 18, fontWeight: 600 }}>Sammenligning</div>
              <button className="link-btn" onClick={() => setList([])} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: T.mono, fontSize: 12, color: T.inkSoft, textDecoration: "underline" }}>
                Ryd alle
              </button>
            </div>
            <div style={{ fontSize: 12.5, color: T.inkSoft, marginBottom: 10 }}>
              Sorteret efter bedste guldværdi. Grøn = laveste pris per gram rent guld.
              {mixedCur && " Poster i anden valuta konkurrerer ikke om bedste køb."}
            </div>
            {[...list].sort((a, b) => a.pricePerG - b.pricePerG).map((x) => {
              const vv = verdictFor(x.overSpot);
              const xUnit = unitFor(x.currency || "DKK");
              const best = x.pricePerG === bestG && (x.currency || "DKK") === currency;
              return (
                <div key={x.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", marginBottom: 8, background: T.card, borderRadius: 6, border: `1px solid ${best ? T.good : T.line}` }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: vv.color, flex: "none" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 600 }}>
                      {x.karat} · {g(x.gram)} · {money(x.price, xUnit)}
                    </div>
                    <div style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 1 }}>
                      {moneyPerG(x.pricePerG, xUnit)} · {pct(x.overSpot)} over spot
                      {best && <span style={{ color: T.good, fontWeight: 600 }}> · bedste køb</span>}
                    </div>
                  </div>
                  <button className="remove-btn" onClick={() => setList((l) => l.filter((i) => i.id !== x.id))} style={{ background: "none", border: "none", cursor: "pointer", color: T.inkSoft, fontSize: 18, lineHeight: 1, padding: 4, flex: "none" }} aria-label="Fjern">×</button>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 28, paddingTop: 14, borderTop: `1px solid ${T.line}`, fontFamily: T.mono, fontSize: 12, color: T.inkSoft, lineHeight: 1.9 }}>
          <div><span style={{ color: T.good }}>●</span> 0–10 % over spot: fremragende &nbsp;·&nbsp; <span style={{ color: T.ok }}>●</span> 10–25 %: OK &nbsp;·&nbsp; <span style={{ color: T.bad }}>●</span> 25 %+: for dyrt</div>
          <div style={{ marginTop: 4 }}>Spot hentes fra gold-api.com. Går hentningen ikke igennem, kan du taste dagens gram-pris selv.</div>
        </div>

      </div>
    </div>
  );
}

function Metric({ label, value, big, accent, span }) {
  return (
    <div style={{ padding: "14px 18px", borderBottom: `1px solid ${T.lineSoft}`, borderRight: `1px solid ${T.lineSoft}`, gridColumn: span ? "1 / -1" : "auto" }}>
      <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: ".1em", textTransform: "uppercase", color: T.inkSoft, marginBottom: 5 }}>{label}</div>
      <div style={{ fontFamily: T.mono, fontSize: big ? 20 : 15, fontWeight: 600, color: accent ? T.gold : T.ink }}>{value}</div>
    </div>
  );
}
