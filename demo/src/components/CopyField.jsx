import { useState } from "react";
import { Row, MonoBox, GhostButton } from "./ui.jsx";

/** A labeled, copy-to-clipboard row for hex ids/hashes/preimages. */
export default function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="mt-2.5">
      <Row label={label}>
        <GhostButton onClick={handleCopy}>{copied ? "Copied ✓" : "Copy"}</GhostButton>
      </Row>
      <MonoBox className="mt-1 text-xs">{value}</MonoBox>
    </div>
  );
}
