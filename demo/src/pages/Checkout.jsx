import { useEffect, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import confetti from "canvas-confetti";
import { verifyQuote } from "bifrost-sdk";
import { buildQuoteRequest, getQuote, createOrder, getOrder, simulatePayment } from "../api.js";
import { humanError } from "../errorMessage.js";
import CopyField from "../components/CopyField.jsx";
import {
  Page,
  Card,
  Divider,
  Row,
  Label,
  Spinner,
  PrimaryButton,
  ErrorBox,
  Subtitle,
  MonoBox,
  QrWrap,
  StatusBadge,
  DarkModeToggle,
} from "../components/ui.jsx";

const POLL_MS = 2000;

const STATUS_COPY = {
  PENDING: { icon: "⏳", text: "Waiting for payment..." },
  INCOMING_HELD: { icon: "🔄", text: "Payment received, routing to Lightning..." },
  OUTGOING_IN_FLIGHT: { icon: "🔄", text: "Payment received, routing to Lightning..." },
  OUTGOING_SETTLED: { icon: "🔄", text: "Almost done — finalizing..." },
  SUCCEEDED: { icon: "✅", text: "Payment complete!" },
  REFUNDING: { icon: "⚠️", text: "Something went wrong — refunding your payment..." },
  FAILED: { icon: "❌", text: "Payment failed." },
};

export default function Checkout() {
  const [params] = useSearchParams();
  const invoice = params.get("invoice") ?? "";
  const amount = params.get("amount") ?? "";
  const merchant = params.get("merchant") ?? "Merchant";

  const [phase, setPhase] = useState("idle"); // idle | quoting | quoted | ordering | ordered
  const [quote, setQuote] = useState(null);
  const [verified, setVerified] = useState(false);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());

  const pollRef = useRef(null);
  const confettiFiredRef = useRef(false);

  // Countdown tick for the quote-expiry display.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => () => stopPolling(), []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function handleGetQuote() {
    setError(null);
    setPhase("quoting");
    try {
      const request = buildQuoteRequest(invoice, amount);
      const q = await getQuote(request);
      verifyQuote(q, request); // throws BifrostError on any §9 checklist failure
      setQuote(q);
      setVerified(true);
      setPhase("quoted");
    } catch (e) {
      setError(humanError(e));
      setPhase("idle");
    }
  }

  async function handleConfirmAndPay() {
    setError(null);
    setPhase("ordering");
    try {
      const o = await createOrder(quote.quoteId, invoice);
      setOrder(o);
      setPhase("ordered");
      startPolling(o.orderId);
    } catch (e) {
      setError(humanError(e));
      setPhase("quoted");
    }
  }

  function startPolling(orderId) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const o = await getOrder(orderId);
        setOrder(o);
        if (o.state === "SUCCEEDED" || o.state === "FAILED") {
          stopPolling();
          if (o.state === "SUCCEEDED" && !confettiFiredRef.current) {
            confettiFiredRef.current = true;
            fireConfetti();
          }
        }
      } catch {
        // transient poll failure — keep trying, the next tick may succeed
      }
    }, POLL_MS);
  }

  if (!invoice || !amount) {
    return (
      <Page>
        <Card>
          <h1 className="text-xl font-semibold mb-1">⚡ Pay with Fiber</h1>
          <ErrorBox>This checkout link is missing required parameters (invoice, amount).</ErrorBox>
        </Card>
      </Page>
    );
  }

  return (
    <Page>
      <DarkModeToggle />
      <Card>
        <Link
          to="/"
          className="inline-block text-muted-foreground hover:text-foreground text-sm mb-1.5 no-underline transition-colors duration-200"
        >
          ← Bifrost
        </Link>
        <h1 className="text-xl font-semibold mb-1">⚡ Pay with Fiber</h1>
        <Row label="Merchant">{merchant}</Row>
        <Row label="Amount">
          <span className="font-mono">{Number(amount).toLocaleString()} sat</span>
        </Row>

        {phase === "idle" && <PrimaryButton onClick={handleGetQuote}>Get Quote</PrimaryButton>}

        {phase === "quoting" && (
          <PrimaryButton disabled>
            <Spinner />
            Getting quote...
          </PrimaryButton>
        )}

        {(phase === "quoted" || phase === "ordering") && quote && (
          <QuotePanel
            quote={quote}
            verified={verified}
            now={now}
            ordering={phase === "ordering"}
            onConfirm={handleConfirmAndPay}
          />
        )}

        {phase === "ordered" && order && <OrderPanel order={order} />}

        {error && <ErrorBox>{error}</ErrorBox>}
      </Card>
    </Page>
  );
}

function QuotePanel({ quote, verified, now, ordering, onConfirm }) {
  const secondsLeft = Math.max(0, Math.round((quote.expiresAt - now) / 1000));
  const expired = secondsLeft <= 0;

  return (
    <>
      <Divider />
      <Row label="You pay">
        <span className="font-mono">{BigInt(quote.giveAmount).toLocaleString()} shannon</span>
      </Row>
      <Row label="Merchant receives">
        <span className="font-mono">{BigInt(quote.getAmount).toLocaleString()} sat</span>
      </Row>
      <Row label="Quote expires in">
        <span className="font-mono">{expired ? "expired" : `${secondsLeft}s`}</span>
      </Row>
      {verified && (
        <div className="mt-3">
          <StatusBadge state="SUCCEEDED">✅ Signature verified</StatusBadge>
        </div>
      )}

      <PrimaryButton disabled={expired || ordering} onClick={onConfirm}>
        {ordering ? (
          <>
            <Spinner />
            Confirming...
          </>
        ) : expired ? (
          "Quote expired — get a new one"
        ) : (
          "Confirm & Pay"
        )}
      </PrimaryButton>
    </>
  );
}

function OrderPanel({ order }) {
  const status = STATUS_COPY[order.state] ?? { icon: "•", text: order.state };
  const succeeded = order.state === "SUCCEEDED";
  const awaitingPayment = order.state === "PENDING";

  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState(null);

  async function handleSimulate() {
    setSimError(null);
    setSimulating(true);
    try {
      await simulatePayment(order.incoming.invoice);
    } catch (e) {
      setSimError(humanError(e));
    } finally {
      setSimulating(false);
    }
  }

  return (
    <>
      <Divider />

      <div className="flex justify-center mb-3">
        <StatusBadge state={order.state}>{order.state}</StatusBadge>
      </div>

      {!succeeded && (
        <QrWrap>
          <QRCodeSVG value={order.incoming.invoice} size={200} />
        </QrWrap>
      )}
      {!succeeded && (
        <>
          <Label>Scan with your Fiber wallet</Label>
          <MonoBox>{order.incoming.invoice}</MonoBox>
        </>
      )}

      {awaitingPayment && (
        <>
          <PrimaryButton disabled={simulating} onClick={handleSimulate}>
            {simulating ? (
              <>
                <Spinner />
                Simulating...
              </>
            ) : (
              "⚡ Simulate Payment (Demo Mode)"
            )}
          </PrimaryButton>
          <Subtitle className="mt-1.5 mb-0 text-center">Demo mode — simulates a Fiber wallet payment</Subtitle>
          {simError && <ErrorBox>{simError}</ErrorBox>}
        </>
      )}

      <div className="text-center pt-5 pb-1.5">
        <div className="text-4xl leading-none mb-2">{status.icon}</div>
        <div className="text-sm text-muted-foreground">
          {succeeded
            ? `Payment complete! Merchant received ${BigInt(order.outgoing.amount).toLocaleString()} sat`
            : status.text}
        </div>
      </div>

      {succeeded && <SucceededDetails order={order} />}
    </>
  );
}

function SucceededDetails({ order }) {
  // Fiber TLC settlement (like Lightning HTLC settlement) resolves off-chain
  // within an already-open payment channel — there is no per-payment CKB or
  // Bitcoin transaction to link to on a block explorer. Both legs share one
  // payment hash and are proven by the same revealed preimage; that's the
  // actual cryptographic proof of payment here, on both networks.
  const preimage = order.incoming.preimage ?? order.outgoing.preimage;

  return (
    <>
      <Divider />
      <h2 className="text-lg font-semibold mb-3">Payment details</h2>
      <Row label="You paid">
        <span className="font-mono">{BigInt(order.incoming.amount).toLocaleString()} shannon</span>
      </Row>
      <Row label="Merchant received">
        <span className="font-mono">{BigInt(order.outgoing.amount).toLocaleString()} sat</span>
      </Row>
      <Row label="Completed">
        <span className="font-mono">{new Date(order.updatedAt).toLocaleString()}</span>
      </Row>

      <CopyField label="Order ID" value={order.orderId} />
      <CopyField label="Payment Hash" value={order.paymentHash} />
      {preimage && <CopyField label="Preimage (proof of payment)" value={preimage} />}

      <Subtitle className="mt-3 mb-0">
        Both legs settle off-chain within existing Fiber and Lightning
        payment channels — verified here by the shared payment hash locking
        funds on both networks, proven by the preimage above, not by a
        per-payment blockchain transaction.
      </Subtitle>
    </>
  );
}

function fireConfetti() {
  confetti({
    particleCount: 140,
    spread: 80,
    origin: { y: 0.6 },
    colors: ["#7c3aed", "#2563eb", "#22c55e"],
  });
}
