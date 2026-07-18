import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { detectInvoice } from "bifrost-sdk";
import { getDemoInvoice, getHealth, getRecentPayments } from "../api.js";
import { humanError } from "../errorMessage.js";
import CopyField from "../components/CopyField.jsx";
import {
  Page,
  Card,
  Divider,
  Row,
  Label,
  TextInput,
  TextArea,
  Spinner,
  PrimaryButton,
  SecondaryButton,
  ButtonRow,
  ErrorBox,
  Subtitle,
  MonoBox,
  QrWrap,
  DarkModeToggle,
} from "../components/ui.jsx";

const RECENT_PAYMENTS_POLL_MS = 30000;
const CKB_TESTNET_EXPLORER = "https://testnet.explorer.nervos.org";

// A placeholder invoice string, purely for exploring the checkout UI
// without a real invoice on hand — not expected to be payable; the hub
// will reject it, and the checkout page's error handling covers that case.
const DEMO_INVOICE =
  "lnbcrt500u1p5jl0xdpp5r6cqmjduswhpm6vjs2y8gy0k48kndlyvn9uzhkypnst56rj0yhz5t" +
  "9qyyssqfjq3nq0jxfjqx2rjqj9jrjz9x0dc3fw2q5vqsvf6kt7wq0uwq6q6q6q6q6q6q6q6q6q6";

export default function MerchantDashboard() {
  const [invoice, setInvoice] = useState("");
  const [merchant, setMerchant] = useState("");
  const [link, setLink] = useState(null);
  const [copied, setCopied] = useState(false);
  const [decodeError, setDecodeError] = useState(null);
  const [generatingInvoice, setGeneratingInvoice] = useState(false);
  const [invoiceFromNode, setInvoiceFromNode] = useState(false);

  const origin = window.location.origin;

  async function generateTestInvoice() {
    setDecodeError(null);
    setGeneratingInvoice(true);
    try {
      const { payment_request } = await getDemoInvoice(5000, "demo payment");
      setInvoice(payment_request);
      setInvoiceFromNode(true);
    } catch (e) {
      setDecodeError(humanError(e));
    } finally {
      setGeneratingInvoice(false);
    }
  }

  function generateLink() {
    setDecodeError(null);
    const trimmedInvoice = invoice.trim();
    const shopName = merchant.trim() || "Merchant";
    if (!trimmedInvoice) {
      setDecodeError("Paste a Lightning invoice first.");
      return;
    }
    let amount;
    try {
      amount = detectInvoice(trimmedInvoice).amount;
    } catch {
      setDecodeError("That doesn't look like a valid invoice.");
      return;
    }
    if (amount === undefined) {
      setDecodeError("Couldn't read an amount from that invoice — it may be amount-less.");
      return;
    }
    const params = new URLSearchParams({
      invoice: trimmedInvoice,
      amount: String(amount),
      merchant: shopName,
    });
    setLink(`${origin}/checkout?${params.toString()}`);
    setCopied(false);
  }

  function tryDemo() {
    setInvoice(DEMO_INVOICE);
    setMerchant("CoffeeShop");
    setDecodeError(null);
    const params = new URLSearchParams({
      invoice: DEMO_INVOICE,
      amount: "50000",
      merchant: "CoffeeShop",
    });
    setLink(`${origin}/checkout?${params.toString()}`);
    setCopied(false);
  }

  async function copyLink() {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Page>
      <DarkModeToggle />
      <Card className="max-w-lg">
        <h1 className="text-xl font-semibold mb-1">⚡ Bifrost Merchant Checkout</h1>
        <Subtitle>Accept Fiber payments for any Lightning invoice.</Subtitle>

        <Label htmlFor="invoice">Your Lightning Invoice</Label>
        <TextArea
          id="invoice"
          placeholder="lnbc..."
          value={invoice}
          onChange={(e) => {
            setInvoice(e.target.value);
            setInvoiceFromNode(false);
          }}
        />
        <ButtonRow>
          <SecondaryButton onClick={generateTestInvoice} disabled={generatingInvoice} className="flex-1">
            {generatingInvoice ? (
              <>
                <Spinner />
                Generating...
              </>
            ) : (
              "Generate Test Invoice"
            )}
          </SecondaryButton>
        </ButtonRow>
        {invoiceFromNode && <Subtitle className="mt-1.5 mb-0">Generated from local regtest node</Subtitle>}

        <Label htmlFor="merchant">Merchant Name</Label>
        <TextInput
          id="merchant"
          type="text"
          placeholder="My Shop"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
        />

        <PrimaryButton onClick={generateLink}>Generate Checkout Link</PrimaryButton>

        {decodeError && <ErrorBox>{decodeError}</ErrorBox>}

        <ButtonRow>
          <SecondaryButton onClick={tryDemo} className="flex-1">
            Try Demo
          </SecondaryButton>
        </ButtonRow>

        {link && <LinkResult link={link} copied={copied} onCopy={copyLink} />}

        <Divider />

        <h2 className="text-lg font-semibold mb-3">How it works</h2>
        <ol className="list-none p-0 m-0" style={{ counterReset: "step" }}>
          {["Paste your Lightning invoice", "Share the checkout link", "Customer pays with Fiber", "You receive Lightning sats"].map(
            (step, i) => (
              <li key={step} className="pl-9 py-2 relative text-muted-foreground text-sm">
                <span className="absolute left-0 top-1.5 w-5.5 h-5.5 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                  {i + 1}
                </span>
                {step}
              </li>
            ),
          )}
        </ol>
      </Card>

      <ExplorerLinks />
      <RecentPayments />
    </Page>
  );
}

function LinkResult({ link, copied, onCopy }) {
  const qrValue = useMemo(() => link, [link]);
  return (
    <>
      <Divider />
      <h2 className="text-lg font-semibold mb-3">Your checkout link</h2>
      <MonoBox>{link}</MonoBox>
      <ButtonRow>
        <SecondaryButton onClick={onCopy} className="flex-1">
          {copied ? "Copied ✓" : "Copy Link"}
        </SecondaryButton>
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="flex-1 flex items-center justify-center bg-secondary text-secondary-foreground font-medium rounded-lg py-3 px-5 no-underline transition-all duration-200 hover:opacity-90"
        >
          Open Preview
        </a>
      </ButtonRow>
      <QrWrap>
        <QRCodeSVG value={qrValue} size={180} />
      </QrWrap>
    </>
  );
}

function ExplorerLinks() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((e) => setError(humanError(e)));
  }, []);

  return (
    <Card className="max-w-lg">
      <h2 className="text-lg font-semibold mb-3">Explorer Links</h2>

      <Subtitle>
        This demo runs on a local CKB dev chain + Bitcoin regtest, not public
        CKB testnet or Lightning mainnet — nothing below resolves on a real
        explorer today. It's here to show what a testnet/mainnet deployment
        would expose.
      </Subtitle>

      <Row label="CKB Testnet Explorer">
        <a
          href={CKB_TESTNET_EXPLORER}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          testnet.explorer.nervos.org →
        </a>
      </Row>
      <Row label="Lightning node info (mainnet ref.)">
        <a href="https://amboss.space" target="_blank" rel="noreferrer" className="text-primary hover:underline">
          amboss.space →
        </a>
      </Row>

      {error && <ErrorBox>{error}</ErrorBox>}

      {health && (
        <>
          <Divider />
          <h2 className="text-lg font-semibold mb-3">Bifrost Hub Node IDs</h2>
          <CopyField label="Fiber Node ID" value={health.fnn.nodeId || "(not connected)"} />
          <CopyField label="Lightning Node ID" value={health.lnd.nodeId || "(not connected)"} />
        </>
      )}

      <Subtitle className="mt-3 mb-0">
        Fiber (CKB) and Lightning payments both settle off-chain within
        payment channels — a swap is verified by its shared payment hash and
        revealed preimage, not by a per-payment blockchain transaction. See
        the checkout page's "Payment details" for that proof on a completed
        order.
      </Subtitle>
    </Card>
  );
}

function RecentPayments() {
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { orders: page } = await getRecentPayments(5);
        if (!cancelled) setOrders(page);
      } catch (e) {
        if (!cancelled) setError(humanError(e));
      }
    }
    load();
    const t = setInterval(load, RECENT_PAYMENTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <Card className="max-w-lg">
      <h2 className="text-lg font-semibold mb-3">Recent Payments</h2>
      {error && <ErrorBox>{error}</ErrorBox>}
      {!error && orders.length === 0 && <Subtitle className="mb-0">No completed swaps yet — they'll show up here live.</Subtitle>}
      {orders.map((o) => (
        <RecentPaymentRow key={o.orderId} order={o} />
      ))}
    </Card>
  );
}

function RecentPaymentRow({ order }) {
  const sat = BigInt(order.outgoing.amount).toLocaleString();
  const preimage = order.incoming.preimage ?? order.outgoing.preimage;
  const [copied, setCopied] = useState(false);

  async function copyPreimage() {
    await navigator.clipboard.writeText(preimage);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex justify-between items-start gap-3 mt-2.5">
      <div>
        <div className="text-sm text-foreground">
          ✅ {sat} sat <span className="text-muted-foreground">· {timeAgo(order.updatedAt)}</span>
        </div>
        <div className="font-mono text-xs text-muted-foreground mt-0.5">
          Hash: {order.paymentHash.slice(0, 10)}...
        </div>
      </div>
      {preimage && (
        <button
          type="button"
          onClick={copyPreimage}
          className="bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground font-medium rounded-lg py-1.5 px-2.5 text-xs transition-colors duration-200 shrink-0"
        >
          {copied ? "Copied ✓" : "Copy proof"}
        </button>
      )}
    </div>
  );
}

function timeAgo(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
