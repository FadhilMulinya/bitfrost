import { useState, useEffect } from "react";

export function useTheme() {
  const getSystem = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark" : "light";

  const [theme, setTheme] = useState(() => {
    return localStorage.getItem("bifrost-theme") || "system";
  });

  const resolved = theme === "system" ? getSystem() : theme;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
    localStorage.setItem("bifrost-theme", theme);
  }, [theme, resolved]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () =>
      document.documentElement.setAttribute("data-theme", getSystem());
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  return { theme, setTheme, resolved };
}
