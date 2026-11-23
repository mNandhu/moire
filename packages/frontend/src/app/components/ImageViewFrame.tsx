import { Suspense, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ImageViewLoading } from "@/features/images/components/viewer/ImageViewLoading";
import { PageErrorBoundary } from "@/app/components/ErrorScreen";

/** The image view's place on screen while it loads, and if it fails: a
 * failed load or render shows there, over the gallery, instead of taking the
 * whole app down with it. */
export function ImageViewFrame({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <div className="fixed inset-0 z-[100] overflow-hidden bg-canvas text-white grid place-items-center">
      <PageErrorBoundary resetKey={pathname}>
        <Suspense fallback={<ImageViewLoading />}>{children}</Suspense>
      </PageErrorBoundary>
    </div>
  );
}
