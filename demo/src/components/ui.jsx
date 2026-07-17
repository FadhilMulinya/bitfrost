/** Shared Tailwind-mapped primitives, wired to the CSS variables in index.css. */

export function Page({ children }) {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans flex flex-col items-center px-4 py-6 pb-16">
      {children}
    </div>
  );
}

export function Card({ children, className = "" }) {
  return (
    <div
      className={`w-full max-w-md bg-card text-card-foreground border border-border rounded-xl shadow-md p-6 mt-4 transition-all duration-200 ${className}`}
    >
      {children}
    </div>
  );
}

export function Divider() {
  return <hr className="border-t border-border my-6" />;
}

export function Row({ label, children, className = "" }) {
  return (
    <div className={`flex justify-between items-baseline gap-3 my-1.5 ${className}`}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm text-right break-all">{children}</span>
    </div>
  );
}

export function Label({ children, htmlFor }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm text-muted-foreground mt-4 mb-1.5">
      {children}
    </label>
  );
}

const inputClasses =
  "w-full bg-input border border-border rounded-lg px-3.5 py-3 text-foreground text-sm outline-none focus:ring-2 focus:ring-ring transition-all duration-200";

export function TextInput(props) {
  return <input {...props} className={inputClasses} />;
}

export function TextArea(props) {
  return <textarea {...props} className={`${inputClasses} font-mono resize-y min-h-20`} />;
}

export function Spinner({ className = "" }) {
  return (
    <span
      className={`inline-block w-3.5 h-3.5 border-2 border-current/30 border-t-current rounded-full animate-spin mr-2 align-[-2px] ${className}`}
    />
  );
}

export function PrimaryButton({ children, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`w-full mt-5 bg-primary text-primary-foreground font-semibold rounded-lg py-3 px-5 shadow-sm transition-all duration-200 hover:opacity-90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({ children, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`bg-secondary text-secondary-foreground font-medium rounded-lg py-3 px-5 transition-all duration-200 hover:opacity-90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/** Muted, low-emphasis action (copy buttons etc.) — bg-muted hover:bg-accent per spec. */
export function GhostButton({ children, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground font-medium rounded-lg py-2 px-3 text-xs transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function ButtonRow({ children }) {
  return <div className="flex gap-2.5 mt-3">{children}</div>;
}

export function ErrorBox({ children }) {
  return (
    <div className="bg-destructive/10 border border-destructive/35 text-destructive rounded-lg px-3.5 py-3 text-sm mt-4">
      {children}
    </div>
  );
}

export function Subtitle({ children, className = "" }) {
  return <p className={`text-muted-foreground text-sm mb-2 ${className}`}>{children}</p>;
}

export function MonoBox({ children, className = "" }) {
  return (
    <div className={`bg-muted border border-border rounded-lg px-3.5 py-3 text-xs break-all mt-2 font-mono ${className}`}>
      {children}
    </div>
  );
}

export function QrWrap({ children }) {
  return (
    <div className="flex justify-center p-6 bg-white border border-border rounded-xl my-4">
      {children}
    </div>
  );
}

/** Status badge colors, per the requested mapping. */
const STATUS_BADGE_CLASSES = {
  PENDING: "bg-muted text-muted-foreground",
  INCOMING_HELD: "bg-accent text-accent-foreground",
  OUTGOING_IN_FLIGHT: "bg-secondary text-secondary-foreground",
  OUTGOING_SETTLED: "bg-secondary text-secondary-foreground",
  SUCCEEDED: "bg-chart-2 text-primary-foreground",
  REFUNDING: "bg-destructive text-destructive-foreground",
  FAILED: "bg-destructive text-destructive-foreground",
};

export function StatusBadge({ state, children }) {
  const cls = STATUS_BADGE_CLASSES[state] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${cls}`}>
      {children}
    </span>
  );
}

export function TopLink({ children, ...props }) {
  return (
    <a
      className="text-muted-foreground hover:text-foreground text-sm mb-1.5 no-underline transition-colors duration-200"
      {...props}
    >
      {children}
    </a>
  );
}

/** Toggles the `.dark` class on <html>. Dark is the default (see index.html). */
export function DarkModeToggle() {
  function toggle() {
    document.documentElement.classList.toggle("dark");
  }
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      className="fixed top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full bg-card border border-border text-foreground shadow-sm hover:bg-accent transition-colors duration-200"
    >
      <span className="dark:hidden">🌙</span>
      <span className="hidden dark:inline">☀️</span>
    </button>
  );
}
