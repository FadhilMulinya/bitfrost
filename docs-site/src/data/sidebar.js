// Sub-items are anchors within their parent page — the site has exactly the
// 8 routes listed in the build checklist (/, and 7 /docs/* pages). Protocol,
// SDK, and Running a Hub are each ONE page with multiple ## sections.
export const SIDEBAR = [
  {
    title: "Getting Started",
    items: [
      { label: "Introduction", to: "/docs/introduction" },
      { label: "Quick Start", to: "/docs/quick-start" },
      { label: "How It Works", to: "/docs/how-it-works" },
    ],
  },
  {
    title: "Protocol (bifrost/0.1)",
    items: [
      { label: "Overview", to: "/docs/protocol#overview" },
      { label: "Asset References", to: "/docs/protocol#asset-references" },
      { label: "Quotes", to: "/docs/protocol#quotes" },
      { label: "Orders", to: "/docs/protocol#orders" },
      { label: "Advertisements", to: "/docs/protocol#advertisements" },
      { label: "Error Codes", to: "/docs/protocol#error-codes" },
    ],
  },
  {
    title: "SDK Reference",
    items: [
      { label: "Installation", to: "/docs/sdk#installation" },
      { label: "Bifrost Client", to: "/docs/sdk#bifrost-client" },
      { label: "discover()", to: "/docs/sdk#discover" },
      { label: "getQuote()", to: "/docs/sdk#getquote" },
      { label: "payAnyInvoice()", to: "/docs/sdk#payanyinvoice" },
      { label: "watchOrder()", to: "/docs/sdk#watchorder" },
      { label: "Types", to: "/docs/sdk#types" },
    ],
  },
  {
    title: "Running a Hub",
    items: [
      { label: "Requirements", to: "/docs/running-a-hub#requirements" },
      { label: "Configuration", to: "/docs/running-a-hub#configuration" },
      { label: "Docker Setup", to: "/docs/running-a-hub#docker-setup" },
      { label: "Liquidity Management", to: "/docs/running-a-hub#liquidity-management" },
      { label: "Economics", to: "/docs/running-a-hub#economics" },
    ],
  },
  {
    title: "Security",
    items: [
      { label: "Trust Model", to: "/docs/security#trust-model" },
      { label: "HTLC Atomicity", to: "/docs/security#htlc-atomicity" },
      { label: "Expiry Invariant", to: "/docs/security#expiry-invariant" },
      { label: "Known Gaps", to: "/docs/security#known-gaps" },
    ],
  },
  {
    title: "API Playground",
    items: [{ label: "Try it live", to: "/docs/playground" }],
  },
];
