import { IncomingCall } from "./components/IncomingCall";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { ApiError, setUnauthorizedHandler } from "./api";
import { App } from "./App";
import { Reminders } from "./components/Reminders";
import { Toaster } from "@/components/ui/sonner";
import { LazyMotion, MotionConfig } from "motion/react";

const loadMotionFeatures = () => import("@/lib/motionFeatures").then((r) => r.default);
import { TooltipProvider } from "@/components/ui/tooltip";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

// Any 401 means the 12 h session ended: re-check /api/me, which flips the app to sign-in.
setUnauthorizedHandler(() => {
  queryClient.setQueryData(["me"], null);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <MotionConfig reducedMotion="user">
        <LazyMotion features={loadMotionFeatures} strict>
        <TooltipProvider delayDuration={300}>
          <App />
          <Reminders />
          <IncomingCall />
          <Toaster />
        </TooltipProvider>
        </LazyMotion>
        </MotionConfig>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
