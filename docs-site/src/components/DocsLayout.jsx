import { Link, useLocation } from "react-router-dom";
import { SIDEBAR } from "../data/sidebar.js";

export default function DocsLayout({ children }) {
  const location = useLocation();
  const currentPath = location.pathname + location.hash;

  return (
    <div className="docs-layout">
      <aside className="sidebar">
        {SIDEBAR.map((section) => (
          <div className="sidebar-section" key={section.title}>
            <div className="sidebar-title">{section.title}</div>
            {section.items.map((item) => {
              const isActive =
                currentPath === item.to ||
                (!item.to.includes("#") && location.pathname === item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`sidebar-link ${isActive ? "active" : ""}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
