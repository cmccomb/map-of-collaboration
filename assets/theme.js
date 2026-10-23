"use strict";

(() => {
  const STORAGE_KEY = "cmu-research-map-theme";
  const MODES = new Set(["light", "system", "dark"]);
  const systemPreference = window.matchMedia("(prefers-color-scheme: dark)");

  function storedMode() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return MODES.has(value) ? value : "system";
    } catch {
      return "system";
    }
  }

  function resolvedMode(mode) {
    return mode === "system"
      ? systemPreference.matches
        ? "dark"
        : "light"
      : mode;
  }

  function persistMode(mode) {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Appearance selection still works when storage is unavailable.
    }
  }

  function applyMode(mode, { persist = false, notify = true } = {}) {
    const selectedMode = MODES.has(mode) ? mode : "system";
    const resolved = resolvedMode(selectedMode);
    const root = document.documentElement;
    root.dataset.theme = selectedMode;
    root.dataset.resolvedTheme = resolved;
    root.style.colorScheme = resolved;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolved === "dark" ? "#0a141e" : "#edf2f4");
    document
      .querySelectorAll('input[name="appearance-mode"]')
      .forEach((input) => {
        input.checked = input.value === selectedMode;
      });
    if (persist) persistMode(selectedMode);
    if (notify) {
      window.dispatchEvent(
        new CustomEvent("collaboration-theme-change", {
          detail: { mode: selectedMode, resolved },
        }),
      );
    }
  }

  applyMode(storedMode(), { notify: false });

  document.addEventListener("DOMContentLoaded", () => {
    applyMode(document.documentElement.dataset.theme, { notify: false });
    document
      .querySelectorAll('input[name="appearance-mode"]')
      .forEach((input) => {
        input.addEventListener("change", () => {
          if (input.checked) applyMode(input.value, { persist: true });
        });
      });
  });

  systemPreference.addEventListener("change", () => {
    if (document.documentElement.dataset.theme === "system") {
      applyMode("system");
    }
  });

  globalThis.CollaborationTheme = Object.freeze({
    applyMode,
    resolvedMode: () => document.documentElement.dataset.resolvedTheme,
  });
})();
