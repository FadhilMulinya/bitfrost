import { Link, useLocation } from "react-router-dom";
import { useTheme } from "../hooks/useTheme.js";

const GITHUB_URL = "https://github.com/FadhilMulinya/bitfrost";

export default function Nav() {
  const { theme, setTheme } = useTheme();
  const location = useLocation();

  const isDocsActive =
    location.pathname.startsWith("/docs") && location.pathname !== "/docs/playground";
  const isPlaygroundActive = location.pathname === "/docs/playground";

  return (
    <nav>
      <div className="nav-left">
        <Link to="/" className="nav-brand">Bifrost</Link>
        <Link to="/docs/introduction" className={`nav-link ${isDocsActive ? "active" : ""}`}>
          Docs
        </Link>
        <Link to="/docs/playground" className={`nav-link ${isPlaygroundActive ? "active" : ""}`}>
          Playground
        </Link>
        <a href={GITHUB_URL} className="nav-link" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>
      <div className="nav-right">
        <div className="theme-toggle">
          <button
            className={`theme-btn ${theme === "light" ? "active" : ""}`}
            onClick={() => setTheme("light")}
          >
            Light
          </button>
          <button
            className={`theme-btn ${theme === "system" ? "active" : ""}`}
            onClick={() => setTheme("system")}
          >
            System
          </button>
          <button
            className={`theme-btn ${theme === "dark" ? "active" : ""}`}
            onClick={() => setTheme("dark")}
          >
            Dark
          </button>
        </div>
      </div>
    </nav>
  );
}
