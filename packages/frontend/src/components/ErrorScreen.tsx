import React from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { EmptyState } from "./ui/EmptyState";
import { Button, ButtonLink } from "./ui/Button";

function messageOf(error: unknown): string | undefined {
  if (isRouteErrorResponse(error)) return error.statusText || undefined;
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : undefined;
}

/** What a crashed page shows instead of a blank screen. */
export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = messageOf(error);
  return (
    <EmptyState
      icon={AlertTriangle}
      title="Something went wrong"
      description={
        message && <span className="block line-clamp-3 break-words">{message}</span>
      }
      actions={
        <>
          <Button onClick={onRetry ?? (() => window.location.reload())}>
            {onRetry ? "Try again" : "Reload"}
          </Button>
          <ButtonLink to="/" variant="ghost">
            Go to All Images
          </ButtonLink>
        </>
      }
    />
  );
}

/** The router's errorElement: anything no page boundary caught. */
export function RouteError() {
  const error = useRouteError();
  console.error(error);
  return (
    <div className="min-h-dvh grid place-items-center text-white">
      <ErrorPanel error={error} />
    </div>
  );
}

/**
 * Catches a page's render errors inside the app shell, so the sidebar stays
 * usable. Clears itself when `resetKey` changes (navigating away).
 */
export class PageErrorBoundary extends React.Component<
  { resetKey: string; children: React.ReactNode },
  { error: unknown; failed: boolean }
> {
  state = { error: undefined as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error(error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: undefined, failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <ErrorPanel
          error={this.state.error}
          onRetry={() => this.setState({ error: undefined, failed: false })}
        />
      );
    }
    return this.props.children;
  }
}
