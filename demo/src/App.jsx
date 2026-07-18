import { BrowserRouter, Routes, Route } from "react-router-dom";
import MerchantDashboard from "./pages/MerchantDashboard.jsx";
import Checkout from "./pages/Checkout.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MerchantDashboard />} />
        <Route path="/checkout" element={<Checkout />} />
      </Routes>
    </BrowserRouter>
  );
}
