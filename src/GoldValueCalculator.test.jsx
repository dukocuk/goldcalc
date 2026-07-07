import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GoldValueCalculator from "./GoldValueCalculator.jsx";

// ozUsd 3110.35 → exactly 100 USD per gram of pure gold
const RATES = { USD: 1, DKK: 7, EUR: 0.9, TRY: 35 };
const okJson = (data) => Promise.resolve({ json: () => Promise.resolve(data) });

const mockSpotFetch = ({ ozUsd = 3110.35, rates = RATES } = {}) =>
  vi.stubGlobal(
    "fetch",
    vi.fn((url) =>
      String(url).includes("gold-api")
        ? okJson({ price: ozUsd })
        : okJson({ rates })
    )
  );

const spotInput = () => screen.getByPlaceholderText(/fx 875|…/);
const priceInput = () => screen.getByLabelText("Pris");
const gramInput = () => screen.getByLabelText("Vægt");
const saveButton = () => screen.getByRole("button", { name: "Gem til sammenligning" });

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spot autoload", () => {
  it("fills the spot input from the API in DKK and shows live status", async () => {
    mockSpotFetch();
    render(<GoldValueCalculator />);
    await waitFor(() => expect(spotInput()).toHaveValue("700")); // 100 USD/g × 7
    expect(screen.getByText(/Live · gold-api\.com \+ FX/)).toBeInTheDocument();
  });

  it("shows the error status when the fetch fails and still allows manual entry", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network"))));
    const user = userEvent.setup();
    render(<GoldValueCalculator />);
    await screen.findByText("Kunne ikke hente — indtast selv");

    await user.type(spotInput(), "875");
    await user.type(priceInput(), "8800");
    await user.type(gramInput(), "12");
    expect(screen.getByText("Manuelt indtastet")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });
});

describe("calculation", () => {
  it("shows a verdict and metrics once price and weight are entered (default 22k)", async () => {
    mockSpotFetch();
    const user = userEvent.setup();
    render(<GoldValueCalculator />);
    await waitFor(() => expect(spotInput()).toHaveValue("700"));

    // 8000 kr for 12 g 22k at spot 700: 8000 / 10.992 g ≈ 727,82 kr/g → ~+4 % over spot
    await user.type(priceInput(), "8000");
    await user.type(gramInput(), "12");

    expect(screen.getByText("Fremragende")).toBeInTheDocument();
    expect(screen.getByText("728 kr/g")).toBeInTheDocument(); // din guldpris
    expect(screen.getByText("10,99 g")).toBeInTheDocument(); // rent guld
    expect(screen.getByText("7.694 kr")).toBeInTheDocument(); // guldværdi ved spot
  });

  it("re-computes when another karat is selected", async () => {
    mockSpotFetch();
    const user = userEvent.setup();
    render(<GoldValueCalculator />);
    await waitFor(() => expect(spotInput()).toHaveValue("700"));

    await user.type(priceInput(), "8000");
    await user.type(gramInput(), "12");
    await user.click(screen.getByRole("button", { name: /14k/ }));

    // 12 g × 0.585 = 7.02 g pure → 8000/7.02 ≈ 1.140 kr/g → ~+63 % over spot
    expect(screen.getByText("For dyrt")).toBeInTheDocument();
    expect(screen.getByText("1.140 kr/g")).toBeInTheDocument();
  });

  it("disables the save button until inputs form a valid calculation", async () => {
    mockSpotFetch();
    const user = userEvent.setup();
    render(<GoldValueCalculator />);
    await waitFor(() => expect(spotInput()).toHaveValue("700"));

    expect(saveButton()).toBeDisabled();
    await user.type(priceInput(), "8000");
    expect(saveButton()).toBeDisabled();
    await user.type(gramInput(), "12");
    expect(saveButton()).toBeEnabled();
  });
});

describe("currency switching", () => {
  it("converts live spot when switching and persists the choice", async () => {
    mockSpotFetch();
    const user = userEvent.setup();
    render(<GoldValueCalculator />);
    await waitFor(() => expect(spotInput()).toHaveValue("700"));

    await user.click(screen.getByRole("button", { name: "EUR" }));
    expect(spotInput()).toHaveValue("90"); // 100 USD/g × 0.9, <300 keeps decimals
    expect(localStorage.getItem("goldcalc.currency")).toBe("EUR");

    await user.click(screen.getByRole("button", { name: "TRY" }));
    expect(spotInput()).toHaveValue("3500");
  });

  it("restores the persisted currency on mount", async () => {
    localStorage.setItem("goldcalc.currency", "USD");
    mockSpotFetch();
    render(<GoldValueCalculator />);
    await waitFor(() => expect(spotInput()).toHaveValue("100"));
    expect(screen.getByRole("button", { name: "USD" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("comparison list", () => {
  it("saves an entry, persists it, and supports remove and clear-all", async () => {
    mockSpotFetch();
    const user = userEvent.setup();
    render(<GoldValueCalculator />);
    await waitFor(() => expect(spotInput()).toHaveValue("700"));

    await user.type(priceInput(), "8000");
    await user.type(gramInput(), "12");
    await user.click(saveButton());

    expect(screen.getByText("Sammenligning")).toBeInTheDocument();
    expect(screen.getByText(/bedste køb/)).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem("goldcalc.list"));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ karat: "22k", gram: 12, price: 8000, currency: "DKK" });

    await user.click(saveButton()); // second copy
    expect(JSON.parse(localStorage.getItem("goldcalc.list"))).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: "Fjern" })[0]);
    expect(JSON.parse(localStorage.getItem("goldcalc.list"))).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Ryd alle" }));
    expect(screen.queryByText("Sammenligning")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("goldcalc.list"))).toEqual([]);
  });

  it("only lets entries in the active currency compete for best buy", async () => {
    // EUR entry has the lowest raw price per gram, but active currency is DKK
    const mk = (over) => ({
      pure: 10.992, goldValue: 7694, overSpot: over, premium: 300,
      spotAtSave: 700, spreadAtSave: 10,
    });
    localStorage.setItem(
      "goldcalc.list",
      JSON.stringify([
        { id: 1, karat: "22k", gram: 12, price: 8800, currency: "DKK", pricePerG: 800, ...mk(5) },
        { id: 2, karat: "22k", gram: 12, price: 990, currency: "EUR", pricePerG: 90, ...mk(5) },
      ])
    );
    mockSpotFetch();
    render(<GoldValueCalculator />);
    await waitFor(() => expect(spotInput()).toHaveValue("700"));

    const rows = screen.getAllByText(/· bedste køb/);
    expect(rows).toHaveLength(1);
    // the DKK row (800 kr/g) is marked best, not the cheaper-looking EUR row
    expect(rows[0].closest("div")).toHaveTextContent("800 kr/g");
    expect(screen.getByText(/Poster i anden valuta konkurrerer ikke/)).toBeInTheDocument();
  });
});
