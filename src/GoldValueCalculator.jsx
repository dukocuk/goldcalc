import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  KARATS, CURRENCIES, unitFor,
  num, money, moneyPerG, g, pct,
  verdictFor, compute, spotInCurrency,
} from "./logic.js";

// ---- design tokens (Dark Luxe Gold) ----
// Colors live in CSS custom properties (see CSS below); T just references them so
// the palette can be tuned in one place. This is a single, deliberate dark look —
// no light/dark auto-switch.
const T = {
  bg: "var(--bg)",
  panel: "var(--panel)",
  panelSolid: "var(--panel-solid)",
  ink: "var(--ink)",
  inkSoft: "var(--ink-soft)",
  inkFaint: "var(--ink-faint)",
  line: "var(--line)",
  lineSoft: "var(--line-soft)",
  gold: "var(--gold)",
  goldDeep: "var(--gold-deep)",
  goldBg: "var(--gold-bg)",
  good: "var(--good)",
  ok: "var(--ok)",
  bad: "var(--bad)",
  mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
  serif: '"Iowan Old Style",Georgia,"Times New Roman",serif',
  sans: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif',
};

// Palette + effects (gradients, glass, hover/focus, transitions) that inline
// styles can't express.
const CSS = `
:root {
  --bg:#0E0C09; --panel:rgba(255,255,255,.035); --panel-solid:#181510;
  --ink:#F2ECDD; --ink-soft:#98917F; --ink-faint:#6E685A;
  --line:rgba(214,167,44,.14); --line-soft:rgba(214,167,44,.08);
  --gold:#E8C775; --gold-deep:#C9962E; --gold-bg:rgba(214,167,44,.10);
  --good:#6FCF97; --ok:#E4B857; --bad:#E0796B;
  color-scheme: dark;
}
* { box-sizing: border-box; }
.gold-text {
  background: linear-gradient(180deg,#F7E4A6 0%,#E8C775 42%,#C9962E 100%);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
}
.glass {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 1px 0 rgba(255,255,255,.04) inset, 0 18px 40px -24px rgba(0,0,0,.8);
  backdrop-filter: blur(6px);
}
input {
  transition: border-color .2s ease, box-shadow .2s ease, background .2s ease;
}
input:focus-visible, button:focus-visible {
  outline: none;
  border-color: var(--gold);
  box-shadow: 0 0 0 3px rgba(214,167,44,.22), 0 0 18px -4px rgba(214,167,44,.4);
}
.pill { transition: border-color .18s ease, background .18s ease, color .18s ease, box-shadow .18s ease, transform .12s ease; }
.pill:hover { border-color: var(--gold); color: var(--ink); }
.pill:active { transform: translateY(1px); }
.pill[aria-pressed="true"] { box-shadow: 0 0 20px -6px rgba(214,167,44,.5); }
.link-btn { transition: color .18s ease; }
.link-btn:hover { color: var(--gold); }
.lift { transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
.lift:hover { transform: translateY(-2px); box-shadow: 0 24px 44px -26px rgba(0,0,0,.9); }
.save-btn { transition: transform .12s ease, box-shadow .2s ease, filter .2s ease; }
.save-btn:not(:disabled):hover { filter: brightness(1.06); box-shadow: 0 14px 30px -12px rgba(214,167,44,.55); }
.save-btn:not(:disabled):active { transform: translateY(1px); }
.remove-btn { transition: color .18s ease, background .18s ease; }
.remove-btn:hover { color: var(--bad); background: rgba(224,121,107,.1); }
.verdict-num, .verdict-label { transition: color .3s ease; }
.meter-fill { transition: left .5s cubic-bezier(.22,1,.36,1); }
@media (max-width: 380px) {
  .metric-grid { grid-template-columns: 1fr !important; }
  .input-grid { grid-template-columns: 1fr !important; }
}
@media (prefers-reduced-motion: reduce) {
  *, .meter-fill, .lift, .save-btn, .pill { transition: none !important; }
  .lift:hover, .save-btn:not(:disabled):hover { transform: none !important; }
}
`;

// map a verdict's semantic tone to the theme color
const toneColor = (v) => T[v.tone];

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

// ---- count-up: animate a finite number toward its new value ----
// Falls back to the raw value when non-finite or when the user prefers reduced
// motion. Returns the current display number (NaN passes straight through).
function useCountUp(value, { enabled = true } = {}) {
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!enabled || reduce || !isFinite(value)) {
      cancelAnimationFrame(rafRef.current);
      setDisplay(value);
      fromRef.current = value;
      return;
    }
    const from = isFinite(fromRef.current) ? fromRef.current : value;
    const to = value;
    if (from === to) { setDisplay(to); return; }
    const dur = 500;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const cur = from + (to - from) * eased;
      setDisplay(cur);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, enabled, reduce]);

  return display;
}

// ---- premium meter: where over-spot lands on the 0–10–25 scale ----
// Purely a visualization of overSpot; no new logic. The track is split into
// excellent (0–10 %), OK (10–25 %) and too-expensive (25–40 %+) zones with a
// marker. Under-spot pins to the far left, far-over pins to the right.
function Meter({ overSpot }) {
  const has = isFinite(overSpot);
  const MAX = 40;
  const posPct = has ? Math.max(0, Math.min(1, overSpot / MAX)) * 100 : 0;
  const v = has ? verdictFor(overSpot) : null;
  return (
    <div style={{ padding: "4px 20px 20px" }}>
      <div style={{ position: "relative", height: 8, borderRadius: 999, overflow: "hidden", background: T.lineSoft }}>
        <div style={{ position: "absolute", inset: 0, display: "flex" }}>
          <div style={{ width: "25%", background: "rgba(111,207,151,.32)" }} />
          <div style={{ width: "37.5%", background: "rgba(228,184,87,.30)" }} />
          <div style={{ flex: 1, background: "rgba(224,121,107,.30)" }} />
        </div>
        {has && (
          <div
            className="meter-fill"
            style={{
              position: "absolute", top: -3, left: `calc(${posPct}% )`, transform: "translateX(-50%)",
              width: 4, height: 14, borderRadius: 999, background: toneColor(v),
              boxShadow: `0 0 10px 1px ${toneColor(v)}`,
            }}
          />
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7, fontFamily: T.mono, fontSize: 10, letterSpacing: ".08em", color: T.inkFaint }}>
        <span>0%</span><span>10%</span><span>25%</span><span>40%+</span>
      </div>
    </div>
  );
}

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

  // animated hero figures (restrained: over-spot % and price per gram only)
  const overCount = useCountUp(r ? r.overSpot : NaN);
  const ppgCount = useCountUp(r ? r.pricePerG : NaN);

  const add = () => {
    if (!r) return;
    setList((l) => [{ id: Date.now(), karat, gram: num(gram), price: num(price), spotAtSave: num(spot), spreadAtSave: num(spread), currency, ...r }, ...l]);
  };

  const S = {
    label: { fontFamily: T.mono, fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: T.inkSoft, marginBottom: 8, display: "block" },
    input: { width: "100%", fontFamily: T.mono, fontSize: 17, color: T.ink, background: "rgba(0,0,0,.28)", border: `1px solid ${T.line}`, borderRadius: 10, padding: "12px 13px", outline: "none" },
    suffix: { position: "absolute", right: 13, top: "50%", transform: "translateY(-50%)", fontFamily: T.mono, fontSize: 13, color: T.inkFaint, pointerEvents: "none" },
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
    <div style={{ position: "relative", background: T.bg, minHeight: "100%", fontFamily: T.sans, color: T.ink, padding: "40px 16px 64px", overflow: "hidden" }}>
      <style>{CSS}</style>
      {/* soft gold glow behind the header */}
      <div aria-hidden style={{ position: "absolute", top: -160, left: "50%", transform: "translateX(-50%)", width: 620, height: 420, background: "radial-gradient(closest-side, rgba(214,167,44,.20), rgba(214,167,44,0) 72%)", pointerEvents: "none", filter: "blur(4px)" }} />
      <div style={{ position: "relative", maxWidth: 560, margin: "0 auto" }}>

        <div style={{ paddingBottom: 22, marginBottom: 24, borderBottom: `1px solid ${T.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
            <span aria-hidden style={{ width: 22, height: 22, borderRadius: "50%", background: "radial-gradient(circle at 35% 30%, #F7E4A6, #C9962E 70%)", boxShadow: "0 0 16px -2px rgba(214,167,44,.6)", flex: "none" }} />
            <span style={{ fontFamily: T.mono, fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase", color: T.gold }}>
              Guldkøb · beregner
            </span>
          </div>
          <h1 className="gold-text" style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 38, lineHeight: 1.05, margin: 0, letterSpacing: "-.015em" }}>
            Guld eller markup?
          </h1>
          <p style={{ color: T.inkSoft, fontSize: 15, lineHeight: 1.55, margin: "14px 0 0", maxWidth: "46ch" }}>
            Spotprisen hentes automatisk. Tast pris, vægt og karat — så ser du din reelle pris per gram rent guld, hvor langt over spot du betaler, og hvad spot skal stige til, før du kan sælge tilbage uden tab.
          </p>
        </div>

        {/* SPOT — auto */}
        <div className="glass" style={{ padding: "18px 18px 16px", marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <label htmlFor="spot-input" style={{ ...S.label, marginBottom: 0 }}>Spotpris (auto)</label>
            <button
              className="link-btn"
              onClick={loadSpot}
              disabled={spotStatus === "loading"}
              style={{ background: "none", border: "none", cursor: spotStatus === "loading" ? "default" : "pointer", fontFamily: T.mono, fontSize: 12, color: T.gold, textDecoration: "underline", textUnderlineOffset: 3, padding: 0 }}
            >
              {spotStatus === "loading" ? "…" : "Opdater"}
            </button>
          </div>
          <div role="group" aria-label="Valuta" style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {CURRENCIES.map((c) => {
              const on = c.code === currency;
              return (
                <button key={c.code} className="pill" aria-pressed={on} onClick={() => changeCurrency(c.code)}
                  style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: "6px 11px", borderRadius: 8, border: `1px solid ${on ? T.gold : T.line}`, background: on ? T.goldBg : "transparent", color: on ? T.gold : T.inkSoft }}>
                  {c.code}
                </button>
              );
            })}
          </div>
          <div style={{ position: "relative" }}>
            <input
              id="spot-input"
              style={{ ...S.input, borderColor: spotStatus === "live" ? "rgba(111,207,151,.5)" : spotStatus === "error" ? "rgba(224,121,107,.5)" : T.line }}
              inputMode="decimal"
              value={spot}
              onChange={(e) => { setSpot(e.target.value); setSpotStatus("manual"); }}
              placeholder={spotStatus === "loading" ? "…" : "fx 875"}
            />
            <span style={S.suffix}>{unit} / gram</span>
          </div>
          <div aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: T.mono, fontSize: 11.5, color: tag.color, marginTop: 10 }}>
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: tag.color, boxShadow: `0 0 8px ${tag.color}`, flex: "none" }} />
            <span>
              {tag.text}
              {spotStatus === "live" && <span style={{ color: T.inkFaint }}> · ren spot, dealer-gram ligger typisk lidt over</span>}
            </span>
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
                  <button key={x.k} className="pill" aria-pressed={on} onClick={() => setKarat(x.k)}
                    style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "9px 13px", borderRadius: 9, border: `1px solid ${on ? T.gold : T.line}`, background: on ? T.goldBg : "transparent", color: on ? T.gold : T.inkSoft }}>
                    {x.k}
                    <span style={{ fontSize: 10.5, color: on ? T.goldDeep : T.inkFaint, marginLeft: 5, fontWeight: 400 }}>
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
            <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.inkFaint, marginTop: 7 }}>
              Rabat en opkøber typisk trækker fra spot ved tilbagekøb — bruges til break-even.
            </div>
          </div>
        </div>

        {/* result */}
        <div className="glass lift" style={{ marginTop: 22, overflow: "hidden" }}>
          <div style={{ padding: "18px 20px", background: v ? "linear-gradient(180deg, rgba(214,167,44,.10), rgba(214,167,44,.02))" : "transparent", borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div>
              <div className="verdict-label" style={{ fontFamily: T.serif, fontSize: 22, fontWeight: 600, color: v ? toneColor(v) : T.inkFaint }}>
                {v ? v.label : "Afventer input"}
              </div>
              <div style={{ fontSize: 13, color: T.inkSoft, marginTop: 3 }}>
                {v ? v.sub : "Udfyld pris, vægt og karat"}
              </div>
            </div>
            <div className="verdict-num" style={{ fontFamily: T.mono, fontSize: 30, fontWeight: 700, color: v ? toneColor(v) : T.inkFaint, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
              {r ? pct(overCount) : "—"}
            </div>
          </div>
          <Meter overSpot={r ? r.overSpot : NaN} />
          <div className="metric-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderTop: `1px solid ${T.lineSoft}` }}>
            <Metric label="Din guldpris" value={r ? moneyPerG(ppgCount, unit) : "—"} big accent />
            <Metric label="Spot-gulv" value={isFinite(num(spot)) ? moneyPerG(num(spot), unit) : "—"} big />
            <Metric label="Rent guld i stykket" value={r ? g(r.pure) : "—"} />
            <Metric label="Guldværdi ved spot" value={r ? money(r.goldValue, unit) : "—"} />
            <Metric label="Merpris over guldværdi" value={r ? (r.premium >= 0 ? "+" : "−") + money(Math.abs(r.premium), unit) : "—"} span />
            <Metric label="Break-even spotpris" value={r && isFinite(r.breakEvenSpot) ? moneyPerG(r.breakEvenSpot, unit) : "—"} />
            <Metric label="Afstand til break-even" value={r && isFinite(r.breakEvenDelta) ? pct(r.breakEvenDelta) : "—"} />
          </div>
        </div>

        <button className="save-btn" onClick={add} disabled={!r}
          style={{ width: "100%", marginTop: 14, padding: "14px", borderRadius: 11, cursor: r ? "pointer" : "not-allowed", fontFamily: T.sans, fontSize: 15, fontWeight: 700, letterSpacing: ".01em", border: "none", background: r ? "linear-gradient(180deg,#F3D98A,#C9962E)" : "rgba(255,255,255,.04)", color: r ? "#241a05" : T.inkFaint, boxShadow: r ? "0 10px 26px -14px rgba(214,167,44,.7)" : "none" }}>
          Gem til sammenligning
        </button>

        {list.length > 0 && (
          <div style={{ marginTop: 30 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <div style={{ fontFamily: T.serif, fontSize: 20, fontWeight: 600 }}>Sammenligning</div>
              <button className="link-btn" onClick={() => setList([])} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: T.mono, fontSize: 12, color: T.inkSoft, textDecoration: "underline", textUnderlineOffset: 3 }}>
                Ryd alle
              </button>
            </div>
            <div style={{ fontSize: 12.5, color: T.inkSoft, marginBottom: 12, lineHeight: 1.5 }}>
              Sorteret efter bedste guldværdi. Grøn = laveste pris per gram rent guld.
              {mixedCur && " Poster i anden valuta konkurrerer ikke om bedste køb."}
            </div>
            {[...list].sort((a, b) => a.pricePerG - b.pricePerG).map((x) => {
              const vv = verdictFor(x.overSpot);
              const xUnit = unitFor(x.currency || "DKK");
              const best = x.pricePerG === bestG && (x.currency || "DKK") === currency;
              return (
                <div key={x.id} className="lift" style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 15px", marginBottom: 9, background: T.panel, borderRadius: 12, border: `1px solid ${best ? "rgba(111,207,151,.55)" : T.line}`, boxShadow: best ? "0 0 26px -10px rgba(111,207,151,.5)" : "none" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: toneColor(vv), boxShadow: `0 0 8px ${toneColor(vv)}`, flex: "none" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 600 }}>
                      {x.karat} · {g(x.gram)} · {money(x.price, xUnit)}
                    </div>
                    <div style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 2 }}>
                      {moneyPerG(x.pricePerG, xUnit)} · {pct(x.overSpot)} over spot
                      {best && <span style={{ color: T.good, fontWeight: 600 }}> · bedste køb</span>}
                    </div>
                  </div>
                  <button className="remove-btn" onClick={() => setList((l) => l.filter((i) => i.id !== x.id))} style={{ background: "none", border: "none", cursor: "pointer", color: T.inkFaint, fontSize: 18, lineHeight: 1, padding: "4px 8px", borderRadius: 8, flex: "none" }} aria-label="Fjern">×</button>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 30, paddingTop: 16, borderTop: `1px solid ${T.line}`, fontFamily: T.mono, fontSize: 12, color: T.inkSoft, lineHeight: 1.9 }}>
          <div><span style={{ color: T.good }}>●</span> 0–10 % over spot: fremragende &nbsp;·&nbsp; <span style={{ color: T.ok }}>●</span> 10–25 %: OK &nbsp;·&nbsp; <span style={{ color: T.bad }}>●</span> 25 %+: for dyrt</div>
          <div style={{ marginTop: 4, color: T.inkFaint }}>Spot hentes fra gold-api.com. Går hentningen ikke igennem, kan du taste dagens gram-pris selv.</div>
        </div>

      </div>
    </div>
  );
}

function Metric({ label, value, big, accent, span }) {
  return (
    <div style={{ padding: "15px 20px", borderBottom: `1px solid ${T.lineSoft}`, borderRight: `1px solid ${T.lineSoft}`, gridColumn: span ? "1 / -1" : "auto" }}>
      <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: ".12em", textTransform: "uppercase", color: T.inkFaint, marginBottom: 6 }}>{label}</div>
      <div className={accent ? "gold-text" : undefined} style={{ fontFamily: T.mono, fontSize: big ? 21 : 15, fontWeight: 600, color: accent ? undefined : T.ink, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
