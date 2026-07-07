import "@testing-library/jest-dom/vitest";

// jsdom has no matchMedia. Report prefers-reduced-motion as matched so
// useCountUp skips animation and tests see final values immediately.
window.matchMedia =
  window.matchMedia ||
  ((query) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
