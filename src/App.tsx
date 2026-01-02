import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { TelegramProvider } from "./context/TelegramContext";
import { ThemeProvider } from "./context/ThemeContext";
import Dashboard from "./pages/Dashboard";
import Accounts from "./pages/Accounts";
import Proxies from "./pages/Proxies";
import Conversations from "./pages/Conversations";
import Campaigns from "./pages/Campaigns";
import Settings from "./pages/Settings";
import SetupGuide from "./pages/SetupGuide";
import Reports from "./pages/Reports";
import Data from "./pages/Data";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <AuthProvider>
        <TelegramProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/accounts" element={<Accounts />} />
                <Route path="/proxies" element={<Proxies />} />
                <Route path="/conversations" element={<Conversations />} />
                <Route path="/campaigns" element={<Campaigns />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/setup" element={<SetupGuide />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/data" element={<Data />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </BrowserRouter>
          </TooltipProvider>
        </TelegramProvider>
      </AuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
