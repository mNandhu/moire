import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/instrument-sans";
// Score digits only (ScoreMark); latin subset.
import "@fontsource/caveat-brush/latin-400.css";
import "./index.css";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RootRoutes from "./RootRoutes";
import { ToastProvider } from "./components/Toasts";
import { ConfirmProvider } from "./components/ConfirmDialog";
import { RouteError } from "./components/ErrorScreen";

const router = createBrowserRouter([
  { path: "*", element: <RootRoutes />, errorElement: <RouteError /> },
]);

// Server-state cache. staleTime keeps the Image feed warm so navigating
// gallery -> ImageView -> gallery reuses already-fetched pages instead of refetching.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
