import React, { useState, useMemo, useEffect, useCallback } from "react";

// ---- design tokens (matches the printed feltkort) ----
const T = {
  paper: "#FBFAF6",
  card: "#FFFFFF",
  ink: "#1C1B18",
  inkSoft: "#5A574E",
  line: "#DED8CA",
  lineSoft: "#EBE7DC",
  gold: "#A67C1A",
  goldBg: "#F6EFDC",
  good: "#3F7A5A",
  ok: "#8A6D1E",
  bad: "#A6483C",
  mono: 'ui-monospace,"SF Mono",Menlo,Consolas,monospace',
  serif: 'Georgia,"Times New Roman",serif',
  sans: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif',
};

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

// parse Danish-style input (comma decimals, dot thousands)
const num = (s) => {
  if (s === "" || s == null) return NaN;
  const v = parseFloat(String(s).replace(/\./g, "").replace(",", "."));
  return isNaN(v) ? NaN : v;
};
const kr = (v) =>
  isFinite(v) ? v.toLocaleString("da-DK", { maximumFractionDigits: 0 }) + " kr" : "—";
const krg = (v) =>
  isFinite(v) ? v.toLocaleString("da-DK", { maximumFractionDigits: 0 }) + " kr/g" : "—";
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

function compute({ spot, price, gram, purity }) {
  const s = num(spot), p = num(price), w = num(gram);
  if (![s, p, w].every(isFinite) || w <= 0 || p <= 0 || s <= 0) return null;
  const pure = w * purity;
  const goldValue = pure * s;
  const pricePerG = p / pure;
  const overSpot = (pricePerG / s - 1) * 100;
  const premium = p - goldValue;
  return { pure, goldValue, pricePerG, overSpot, premium };
}

// ---- live spot fetch (DKK per gram of pure gold) ----
// goldprice.org sends no Access-Control-Allow-Origin header. In dev this goes
// through the Vite proxy (vite.config.js, /api/goldprice); in production
// (GitHub Pages, no server-side proxy available) it's routed through the
// public CORS proxy corsproxy.io instead.
const GOLDPRICE_BASE = "https://data-asg.goldprice.org/dbXRates";
function goldpriceUrl(path) {
  if (import.meta.env.DEV) return `/api/goldprice/${path}`;
  return `https://corsproxy.io/?url=${encodeURIComponent(`${GOLDPRICE_BASE}/${path}`)}`;
}
async function fetchSpotDKKperGram() {
  // 1) goldprice.org, DKK per ounce directly
  try {
    const r = await fetch(goldpriceUrl("DKK"), { cache: "no-store" });
    const d = await r.json();
    const oz = d?.items?.[0]?.xauPrice;
    if (oz > 0) return { value: oz / OZ, source: "goldprice.org" };
  } catch (e) { /* fall through */ }
  // 2) goldprice.org USD per ounce × USD→DKK
  try {
    const [gr, fr] = await Promise.all([
      fetch(goldpriceUrl("USD"), { cache: "no-store" }),
      fetch("https://open.er-api.com/v6/latest/USD", { cache: "no-store" }),
    ]);
    const gd = await gr.json();
    const fx = await fr.json();
    const ozUsd = gd?.items?.[0]?.xauPrice;
    const dkk = fx?.rates?.DKK;
    if (ozUsd > 0 && dkk > 0) return { value: (ozUsd / OZ) * dkk, source: "goldprice.org + FX" };
  } catch (e) { /* fall through */ }
  throw new Error("no-source");
}

export default function GoldValueCalculator() {
  const [spot, setSpot] = useState("");
  const [spotStatus, setSpotStatus] = useState("loading"); // loading | live | manual | error
  const [spotMeta, setSpotMeta] = useState({ time: "", source: "" });
  const [price, setPrice] = useState("");
  const [gram, setGram] = useState("");
  const [karat, setKarat] = useState("22k");
  const [list, setList] = useState([]);

  const loadSpot = useCallback(async () => {
    setSpotStatus("loading");
    try {
      const { value, source } = await fetchSpotDKKperGram();
      setSpot(String(Math.round(value)));
      setSpotMeta({
        time: new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" }),
        source,
      });
      setSpotStatus("live");
    } catch (e) {
      setSpotStatus("error");
    }
  }, []);

  useEffect(() => { loadSpot(); }, [loadSpot]);

  const purity = KARATS.find((x) => x.k === karat).purity;
  const r = useMemo(() => compute({ spot, price, gram, purity }), [spot, price, gram, purity]);
  const v = r ? verdictFor(r.overSpot) : null;
  const bestG = list.length ? Math.min(...list.map((x) => x.pricePerG)) : Infinity;

  const add = () => {
    if (!r) return;
    setList((l) => [{ id: Date.now(), karat, gram: num(gram), price: num(price), ...r }, ...l]);
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
      <div style={{ maxWidth: 560, margin: "0 auto" }}>

        <div style={{ borderBottom: `2px solid ${T.ink}`, paddingBottom: 16, marginBottom: 22 }}>
          <div style={{ fontFamily: T.mono, fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase", color: T.gold, marginBottom: 8 }}>
            Guldkøb · beregner
          </div>
          <h1 style={{ fontFamily: T.serif, fontWeight: 600, fontSize: 30, lineHeight: 1.1, margin: 0, letterSpacing: "-.01em" }}>
            Guld eller markup?
          </h1>
          <p style={{ color: T.inkSoft, fontSize: 14.5, margin: "10px 0 0", maxWidth: "44ch" }}>
            Spotprisen hentes automatisk. Tast pris, vægt og karat — så ser du din reelle pris per gram rent guld og hvor langt over spot du betaler.
          </p>
        </div>

        {/* SPOT — auto */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <label style={{ ...S.label, marginBottom: 0 }}>Spotpris (auto)</label>
            <button
              onClick={loadSpot}
              disabled={spotStatus === "loading"}
              style={{ background: "none", border: "none", cursor: spotStatus === "loading" ? "default" : "pointer", fontFamily: T.mono, fontSize: 12, color: T.gold, textDecoration: "underline", padding: 0 }}
            >
              {spotStatus === "loading" ? "…" : "Opdater"}
            </button>
          </div>
          <div style={{ position: "relative" }}>
            <input
              style={{ ...S.input, borderColor: spotStatus === "live" ? T.good : spotStatus === "error" ? T.bad : T.line }}
              inputMode="decimal"
              value={spot}
              onChange={(e) => { setSpot(e.target.value); setSpotStatus("manual"); }}
              placeholder={spotStatus === "loading" ? "…" : "fx 875"}
            />
            <span style={S.suffix}>kr / gram</span>
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 11.5, color: tag.color, marginTop: 6 }}>
            {tag.text}
            {spotStatus === "live" && <span style={{ color: T.inkSoft }}> · ren spot, dealer-gram ligger typisk lidt over</span>}
          </div>
        </div>

        {/* inputs */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={{ position: "relative" }}>
            <label style={S.label}>Pris</label>
            <div style={{ position: "relative" }}>
              <input style={S.input} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="8.800" />
              <span style={S.suffix}>kr</span>
            </div>
          </div>
          <div style={{ position: "relative" }}>
            <label style={S.label}>Vægt</label>
            <div style={{ position: "relative" }}>
              <input style={S.input} inputMode="decimal" value={gram} onChange={(e) => setGram(e.target.value)} placeholder="12" />
              <span style={S.suffix}>g</span>
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={S.label}>Karat</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
              {KARATS.map((x) => {
                const on = x.k === karat;
                return (
                  <button key={x.k} onClick={() => setKarat(x.k)}
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
            <Metric label="Din guldpris" value={r ? krg(r.pricePerG) : "—"} big accent />
            <Metric label="Spot-gulv" value={isFinite(num(spot)) ? krg(num(spot)) : "—"} big />
            <Metric label="Rent guld i stykket" value={r ? g(r.pure) : "—"} />
            <Metric label="Guldværdi ved spot" value={r ? kr(r.goldValue) : "—"} />
            <Metric label="Merpris over guldværdi" value={r ? (r.premium >= 0 ? "+" : "−") + kr(Math.abs(r.premium)) : "—"} span />
          </div>
        </div>

        <button onClick={add} disabled={!r}
          style={{ width: "100%", marginTop: 12, padding: "13px", borderRadius: 6, cursor: r ? "pointer" : "not-allowed", fontFamily: T.sans, fontSize: 15, fontWeight: 600, border: `1px solid ${r ? T.ink : T.line}`, background: r ? T.ink : T.card, color: r ? T.paper : T.inkSoft }}>
          Gem til sammenligning
        </button>

        {list.length > 0 && (
          <div style={{ marginTop: 26 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <div style={{ fontFamily: T.serif, fontSize: 18, fontWeight: 600 }}>Sammenligning</div>
              <button onClick={() => setList([])} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: T.mono, fontSize: 12, color: T.inkSoft, textDecoration: "underline" }}>
                Ryd alle
              </button>
            </div>
            <div style={{ fontSize: 12.5, color: T.inkSoft, marginBottom: 10 }}>
              Sorteret efter bedste guldværdi. Grøn = laveste pris per gram rent guld.
            </div>
            {[...list].sort((a, b) => a.pricePerG - b.pricePerG).map((x) => {
              const vv = verdictFor(x.overSpot);
              const best = x.pricePerG === bestG;
              return (
                <div key={x.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", marginBottom: 8, background: T.card, borderRadius: 6, border: `1px solid ${best ? T.good : T.line}` }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: vv.color, flex: "none" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 600 }}>
                      {x.karat} · {g(x.gram)} · {kr(x.price)}
                    </div>
                    <div style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 1 }}>
                      {krg(x.pricePerG)} · {pct(x.overSpot)} over spot
                      {best && <span style={{ color: T.good, fontWeight: 600 }}> · bedste køb</span>}
                    </div>
                  </div>
                  <button onClick={() => setList((l) => l.filter((i) => i.id !== x.id))} style={{ background: "none", border: "none", cursor: "pointer", color: T.inkSoft, fontSize: 18, lineHeight: 1, padding: 4, flex: "none" }} aria-label="Fjern">×</button>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: 28, paddingTop: 14, borderTop: `1px solid ${T.line}`, fontFamily: T.mono, fontSize: 12, color: T.inkSoft, lineHeight: 1.9 }}>
          <div><span style={{ color: T.good }}>●</span> 0–10 % over spot: fremragende &nbsp;·&nbsp; <span style={{ color: T.ok }}>●</span> 10–25 %: OK &nbsp;·&nbsp; <span style={{ color: T.bad }}>●</span> 25 %+: for dyrt</div>
          <div style={{ marginTop: 4 }}>Spot hentes fra goldprice.org. Går hentningen ikke igennem, kan du taste dagens gram-pris selv.</div>
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
