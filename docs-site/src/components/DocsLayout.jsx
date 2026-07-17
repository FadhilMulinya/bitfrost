import { Link, useLocation } from "react-router-dom";
import { SIDEBAR } from "../data/sidebar.js";

export default function DocsLayout({ children }) {
  const location = useLocation();
  const currentPath = location.pathname + location.hash;

  return (
    <div className="sidebar-layout">
      <aside className="sidebar">
        <Link to="/">Bifrost</Link>
        {SIDEBAR.map((section) => (
          <div key={section.title}>
            <div className="section-title">{section.title}</div>
            {section.items.map((item) => {
              const isActive =
                currentPath === item.to ||
                (!item.to.includes("#") && location.pathname === item.to);
              return (
                <Link key={item.to} to={item.to} className={isActive ? "active" : undefined}>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </aside>
      <main className="container">{children}</main>
    </div>
  );
}
