import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { SIDEBAR } from "../data/sidebar.js";

export default function DocsLayout({ children }) {
  const location = useLocation();
  const [activeSection, setActiveSection] = useState(location.hash.replace("#", ""));

  useEffect(() => {
    setActiveSection(location.hash.replace("#", ""));

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
          }
        });
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );

    document.querySelectorAll("h2[id], h3[id]").forEach((el) => {
      observer.observe(el);
    });

    return () => observer.disconnect();
  }, [location.pathname, location.hash]);

  return (
    <div className="docs-layout">
      <aside className="sidebar">
        {SIDEBAR.map((section) => (
          <div className="sidebar-section" key={section.title}>
            <div className="sidebar-title">{section.title}</div>
            {section.items.map((item) => {
              const [itemPath, itemHash] = item.to.split("#");
              const isActive = itemHash
                ? location.pathname === itemPath && activeSection === itemHash
                : location.pathname === itemPath;
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
