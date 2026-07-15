import { useMemo, useState } from "react";
import { useOrderStream } from "./api.ts";
import { OrderTable } from "./panels/OrderTable.tsx";
import { InventoryPanel } from "./panels/InventoryPanel.tsx";
import { QuoteStatsPanel } from "./panels/QuoteStatsPanel.tsx";
import { HealthPanel } from "./panels/HealthPanel.tsx";
import { SwapTheater } from "./panels/SwapTheater.tsx";

export function App() {
  const { orders, connected } = useOrderStream();
  const [selected, setSelected] = useState<string>();
  const list = useMemo(
    () => [...orders.values()].sort((a, b) => b.createdAt - a.createdAt),
    [orders],
  );
  // theater follows the selected order, else the most recently active one
  const theaterOrder = selected
    ? orders.get(selected)
    : [...orders.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];

  return (
    <div className="app">
      <header>
        <h1>bifrost <span className="muted">operator</span></h1>
        <span className={`badge ${connected ? "s-success" : "s-failed"}`}>
          {connected ? "stream live" : "stream down"}
        </span>
      </header>
      <main className="grid">
        <SwapTheater order={theaterOrder} />
        <OrderTable orders={list} onSelect={setSelected} selected={selected} />
        <InventoryPanel />
        <QuoteStatsPanel />
        <HealthPanel />
      </main>
    </div>
  );
}
