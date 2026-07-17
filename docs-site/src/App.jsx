import { BrowserRouter, Routes, Route } from "react-router-dom";
import Landing from "./pages/Landing.jsx";
import Introduction from "./pages/Introduction.jsx";
import QuickStart from "./pages/QuickStart.jsx";
import HowItWorks from "./pages/HowItWorks.jsx";
import Protocol from "./pages/Protocol.jsx";
import Sdk from "./pages/Sdk.jsx";
import RunningAHub from "./pages/RunningAHub.jsx";
import Security from "./pages/Security.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/docs/introduction" element={<Introduction />} />
        <Route path="/docs/quick-start" element={<QuickStart />} />
        <Route path="/docs/how-it-works" element={<HowItWorks />} />
        <Route path="/docs/protocol" element={<Protocol />} />
        <Route path="/docs/sdk" element={<Sdk />} />
        <Route path="/docs/running-a-hub" element={<RunningAHub />} />
        <Route path="/docs/security" element={<Security />} />
      </Routes>
    </BrowserRouter>
  );
}
