import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { TelegramProvider } from "./context/TelegramContext";
import Dashboard from "./pages/Dashboard";
import Accounts from "./pages/Accounts";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TelegramProvider>
        <TooltipProvider>
          <div className="dark">
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/proxies" element={<Dashboard />} />
                <Route path="/maturation" element={<Dashboard />} />
                <Route path="/chat" element={<Dashboard />} />
                <Route path="/campaigns" element={<Dashboard />} />
                <Route path="/admins" element={<Dashboard />} />
                <Route path="/settings" element={<Dashboard />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </BrowserRouter>
          </div>
        </TooltipProvider>
      </TelegramProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
