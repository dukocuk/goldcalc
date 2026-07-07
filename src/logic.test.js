import { describe, it, expect } from "vitest";
import {
  num, money, moneyPerG, g, pct,
  verdictFor, compute, spotInCurrency, unitFor, KARATS,
} from "./logic.js";

describe("num — Danish-style input parsing", () => {
  it("parses plain integers and decimals", () => {
    expect(num("875")).toBe(875);
    expect(num("0.5")).toBe(0.5);
  });

  it("treats comma as decimal separator", () => {
    expect(num("8,5")).toBe(8.5);
    expect(num("0,916")).toBe(0.916);
  });

  it("handles dot thousands with comma decimals", () => {
    expect(num("8.800,50")).toBe(8800.5);
    expect(num("1.234.567,89")).toBe(1234567.89);
  });

  it("treats a lone dot grouping exactly 3 digits as thousands", () => {
    expect(num("8.800")).toBe(8800);
    expect(num("12.345")).toBe(12345);
  });

  it("treats a lone dot NOT grouping 3 digits as a decimal point", () => {
    expect(num("8.8")).toBe(8.8);
    expect(num("8.85")).toBe(8.85);
    expect(num("8.8501")).toBe(8.8501);
  });

  it("strips multiple dots as thousands separators", () => {
    expect(num("1.234.567")).toBe(1234567);
  });

  it("trims whitespace", () => {
    expect(num("  875 ")).toBe(875);
  });

  it("returns NaN for empty, null, undefined and garbage", () => {
    expect(num("")).toBeNaN();
    expect(num(null)).toBeNaN();
    expect(num(undefined)).toBeNaN();
    expect(num("abc")).toBeNaN();
    expect(num(",")).toBeNaN();
  });
});

describe("compute", () => {
  const purity22k = KARATS.find((x) => x.k === "22k").purity; // 0.916
  const base = { spot: "875", price: "10500", gram: "12", purity: purity22k, spread: "10" };

  it("computes pure weight, gold value, price per gram, over-spot and premium", () => {
    const r = compute(base);
    expect(r).not.toBeNull();
    expect(r.pure).toBeCloseTo(12 * 0.916, 10); // 10.992 g
    expect(r.goldValue).toBeCloseTo(10.992 * 875, 6);
    expect(r.pricePerG).toBeCloseTo(10500 / 10.992, 6);
    expect(r.overSpot).toBeCloseTo((10500 / 10.992 / 875 - 1) * 100, 6);
    expect(r.premium).toBeCloseTo(10500 - 10.992 * 875, 6);
  });

  it("accepts Danish-formatted strings", () => {
    const r = compute({ ...base, price: "10.500", gram: "12,0" });
    expect(r.pricePerG).toBeCloseTo(10500 / 10.992, 6);
  });

  it("computes break-even from the spread", () => {
    const r = compute(base);
    const ppg = 10500 / 10.992;
    expect(r.breakEvenSpot).toBeCloseTo(ppg / 0.9, 6);
    expect(r.breakEvenDelta).toBeCloseTo((ppg / 0.9 / 875 - 1) * 100, 6);
  });

  it("zero spread means break-even equals price per gram", () => {
    const r = compute({ ...base, spread: "0" });
    expect(r.breakEvenSpot).toBeCloseTo(r.pricePerG, 10);
  });

  it("leaves break-even undefined for blank, negative or >=100% spread", () => {
    for (const spread of ["", "-5", "100", "150", "abc"]) {
      const r = compute({ ...base, spread });
      expect(r).not.toBeNull();
      expect(r.breakEvenSpot).toBeUndefined();
      expect(r.breakEvenDelta).toBeUndefined();
    }
  });

  it("returns null when any core input is missing or invalid", () => {
    expect(compute({ ...base, spot: "" })).toBeNull();
    expect(compute({ ...base, price: "abc" })).toBeNull();
    expect(compute({ ...base, gram: "" })).toBeNull();
  });

  it("returns null for zero or negative spot, price or weight", () => {
    expect(compute({ ...base, spot: "0" })).toBeNull();
    expect(compute({ ...base, spot: "-875" })).toBeNull();
    expect(compute({ ...base, price: "0" })).toBeNull();
    expect(compute({ ...base, gram: "0" })).toBeNull();
    expect(compute({ ...base, gram: "-1" })).toBeNull();
  });
});

describe("verdictFor — over-spot thresholds", () => {
  it("negative → under spot (good)", () => {
    const v = verdictFor(-3);
    expect(v.label).toBe("Under spot");
    expect(v.tone).toBe("good");
  });

  it("0–10% inclusive → excellent (good)", () => {
    expect(verdictFor(0).label).toBe("Fremragende");
    expect(verdictFor(10).label).toBe("Fremragende");
    expect(verdictFor(10).tone).toBe("good");
  });

  it("10–25% → OK", () => {
    expect(verdictFor(10.1).label).toBe("OK");
    expect(verdictFor(25).label).toBe("OK");
    expect(verdictFor(25).tone).toBe("ok");
  });

  it("above 25% → too expensive (bad)", () => {
    expect(verdictFor(25.1).label).toBe("For dyrt");
    expect(verdictFor(25.1).tone).toBe("bad");
  });

  it("non-finite → null", () => {
    expect(verdictFor(NaN)).toBeNull();
    expect(verdictFor(Infinity)).toBeNull();
  });
});

describe("spotInCurrency", () => {
  // ozUsd 3110.35 / 31.1035 g per oz = exactly 100 USD per gram
  const raw = { ozUsd: 3110.35, rates: { USD: 1, DKK: 7, EUR: 0.9 } };

  it("rounds to whole units at 300 and above", () => {
    expect(spotInCurrency(raw, "DKK")).toBe(700);
  });

  it("keeps two decimals below 300", () => {
    expect(spotInCurrency({ ozUsd: 3110.35, rates: { EUR: 0.91555 } }, "EUR")).toBe(91.56);
    expect(spotInCurrency(raw, "USD")).toBe(100);
  });

  it("returns NaN for missing rate or bad ounce price", () => {
    expect(spotInCurrency(raw, "SEK")).toBeNaN();
    expect(spotInCurrency({ ozUsd: 0, rates: { DKK: 7 } }, "DKK")).toBeNaN();
    expect(spotInCurrency({ ozUsd: 3110.35, rates: null }, "DKK")).toBeNaN();
  });
});

describe("unitFor", () => {
  it("maps known currency codes", () => {
    expect(unitFor("DKK")).toBe("kr");
    expect(unitFor("TRY")).toBe("₺");
    expect(unitFor("EUR")).toBe("€");
    expect(unitFor("USD")).toBe("$");
  });

  it("falls back to DKK for unknown codes", () => {
    expect(unitFor("SEK")).toBe("kr");
    expect(unitFor(undefined)).toBe("kr");
  });
});

describe("formatters (da-DK)", () => {
  it("money formats with dot thousands and no decimals", () => {
    expect(money(8800, "kr")).toBe("8.800 kr");
    expect(money(8800.6, "kr")).toBe("8.801 kr");
    expect(money(NaN, "kr")).toBe("—");
  });

  it("moneyPerG appends /g", () => {
    expect(moneyPerG(875, "kr")).toBe("875 kr/g");
    expect(moneyPerG(Infinity, "kr")).toBe("—");
  });

  it("g formats up to two decimals", () => {
    expect(g(10.992)).toBe("10,99 g");
    expect(g(12)).toBe("12 g");
    expect(g(NaN)).toBe("—");
  });

  it("pct uses explicit sign (U+2212 minus) and rounds to whole percent", () => {
    expect(pct(12.3)).toBe("+12 %");
    expect(pct(0)).toBe("+0 %");
    expect(pct(-3.7)).toBe("−4 %");
    expect(pct(NaN)).toBe("—");
  });
});
