import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { TelegramProvider } from "./context/TelegramContext";
import { ThemeProvider } from "./context/ThemeContext";
import ProtectedRoute from "./components/ProtectedRoute";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Accounts from "./pages/Accounts";
import Proxies from "./pages/Proxies";
import Conversations from "./pages/Conversations";
import Campaigns from "./pages/Campaigns";
import Settings from "./pages/Settings";
import SetupGuide from "./pages/SetupGuide";
import Reports from "./pages/Reports";
import Material from "./pages/Material";
import Seats from "./pages/Seats";
import SeatChat from "./pages/SeatChat";
import Warmup from "./pages/Warmup";
import Logs from "./pages/Logs";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Wraps protected routes with TelegramProvider so the public /seat route
// doesn't spin up global realtime channels + a full conversations preload
// (which was starving the seat page's own realtime subscription).
const ProtectedShell = ({ children }: { children: React.ReactNode }) => (
  <TelegramProvider>
    <ProtectedRoute>{children}</ProtectedRoute>
  </TelegramProvider>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              {/* Public routes (no TelegramProvider — keeps realtime lean) */}
              <Route path="/login" element={<Login />} />
              <Route path="/seat/:token" element={<SeatChat />} />

              {/* Protected routes */}
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<ProtectedShell><Dashboard /></ProtectedShell>} />
              <Route path="/accounts" element={<ProtectedShell><Accounts /></ProtectedShell>} />
              <Route path="/proxies" element={<ProtectedShell><Proxies /></ProtectedShell>} />
              <Route path="/conversations" element={<ProtectedShell><Conversations /></ProtectedShell>} />
              <Route path="/campaigns" element={<ProtectedShell><Campaigns /></ProtectedShell>} />
              <Route path="/settings" element={<ProtectedShell><Settings /></ProtectedShell>} />
              <Route path="/setup" element={<ProtectedShell><SetupGuide /></ProtectedShell>} />
              <Route path="/reports" element={<ProtectedShell><Reports /></ProtectedShell>} />
              <Route path="/material" element={<ProtectedShell><Material /></ProtectedShell>} />
              <Route path="/seats" element={<ProtectedShell><Seats /></ProtectedShell>} />
              <Route path="/warmup" element={<ProtectedShell><Warmup /></ProtectedShell>} />
              <Route path="/logs" element={<ProtectedShell><Logs /></ProtectedShell>} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
