import { useState } from "react";

export default function CodeBlock({ children }) {
  const [copied, setCopied] = useState(false);
  const text = typeof children === "string" ? children : String(children);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="code-block">
      <button className="copy-btn" onClick={onCopy}>{copied ? "Copied" : "Copy"}</button>
      <pre>{text}</pre>
    </div>
  );
}
