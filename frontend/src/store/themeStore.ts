import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark" | "system";

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: "light" | "dark";
  initTheme: () => void;
  applyTheme: (theme: Theme) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "system",
      setTheme: (theme) => {
        set({ theme });
        get().applyTheme(theme);
      },
      resolvedTheme: "dark",
      initTheme: () => {
        const { theme } = get();
        get().applyTheme(theme);
      },
      applyTheme: (theme: Theme) => {
        if (typeof window === "undefined") return;

        const root = window.document.documentElement;
        root.classList.remove("light", "dark");

        let resolved: "light" | "dark";
        if (theme === "system") {
          resolved = window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
        } else {
          resolved = theme;
        }

        root.classList.add(resolved);
        set({ resolvedTheme: resolved });
      },
    }),
    {
      name: "theme-storage",
    },
  ),
);

// Initialize theme on import
if (typeof window !== "undefined") {
  useThemeStore.getState().initTheme();

  // Listen for system theme changes
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", () => {
    const { theme, initTheme } = useThemeStore.getState();
    if (theme === "system") {
      initTheme();
    }
  });
}
