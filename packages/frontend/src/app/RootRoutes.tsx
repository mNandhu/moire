import { Suspense, useEffect, useState } from "react";
import { Navigate, Routes, Route, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { OverlayOpenContext, getBackgroundLocation } from "@/lib/backgroundLocation";
import App from "./App";
import AllImagesPage from "@/pages/AllImagesPage";
import ImageView from "@/pages/ImageView";
import NotFoundPage from "@/pages/NotFoundPage";
import { useRefreshOnFinish } from "@/features/activity/hooks/useBackgroundTasks";
import { useTrackHistory } from "@/app/hooks/useHistoryNav";
import { ONBOARDING_KEY, SET_UP_KEY, fetchOnboarding } from "@/features/onboarding/lib/onboarding";
import { readLocalPref, writeLocalPref } from "@/lib/localPref";
import { lazyPage } from "@/lib/lazyPage";
import { ShortcutHelp } from "@/app/components/ShortcutOverlay";
import { HoldRoute } from "@/app/components/HoldRoute";

// Pages off the gallery's path load on first visit, so the first paint
// doesn't wait for Generate's code. The gallery and the image view (it opens
// over the gallery, instantly) stay in the main bundle.
const OverviewPage = lazyPage(() => import("@/pages/OverviewPage"));
const LibrariesPage = lazyPage(() => import("@/pages/LibrariesPage"));
const CharacterPage = lazyPage(() => import("@/pages/CharacterPage"));
const SettingsPage = lazyPage(() => import("@/pages/SettingsPage"));
const AITaggingPage = lazyPage(() => import("@/pages/AITaggingPage"));
const RulesPage = lazyPage(() => import("@/pages/RulesPage"));
const GeneratePage = lazyPage(() => import("@/pages/GeneratePage"));
const GenerationsPage = lazyPage(() => import("@/pages/GenerationsPage"));
const OutfitsPage = lazyPage(() => import("@/pages/OutfitsPage"));
const WorkflowSetupPage = lazyPage(() => import("@/pages/WorkflowSetupPage"));
const BatchPage = lazyPage(() => import("@/pages/BatchPage"));
const WelcomePage = lazyPage(() => import("@/pages/WelcomePage"));
const TagsPage = lazyPage(() => import("@/pages/TagsPage"));
const TagGroupPage = lazyPage(() => import("@/pages/TagsPage").then((m) => ({ default: m.TagGroupPage })));

// ImageView opens over the gallery rather than replacing it: opening a thumbnail
// pushes `/image/:id` with `state.backgroundLocation` set to the gallery location
// it came from. The gallery `<Routes>` below then keeps matching that background
// location (so `App`/`AllImagesPage` never unmount and every tile's load state
// survives the round trip) while a second `<Routes>` matches the *real* location
// and renders `ImageView` as an overlay on top. A direct link or refresh on
// `/image/:id` carries no `backgroundLocation`, so it falls through to the
// `/image/:id` entry in the first `<Routes>` and renders standalone, same as before.
export default function RootRoutes() {
  const location = useLocation();
  const backgroundLocation = getBackgroundLocation(location);
  // Here, not in App: an image opened by link or after a reload renders
  // without App, and its tags still refresh when its AI tagging ends.
  useRefreshOnFinish();
  useTrackHistory();
  // A fresh install (no libraries, setup neither finished nor skipped) opens
  // on the welcome page. Nothing renders until that's known, so the empty
  // gallery doesn't flash first; if the check fails, the app opens as usual.
  // A browser that has seen setup over doesn't wait: the gallery's first
  // page was queued behind this check. A server reset behind it (its data
  // wiped, same address) then shows the empty gallery for that moment before
  // the welcome page: rare, and accepted.
  const onboarding = useQuery({
    queryKey: ONBOARDING_KEY,
    queryFn: ({ signal }) => fetchOnboarding(signal),
    staleTime: Infinity,
    retry: false,
  });
  const [setUp] = useState(() => readLocalPref(SET_UP_KEY) === "1");
  const status = onboarding.data?.status;
  useEffect(() => {
    if (status) writeLocalPref(SET_UP_KEY, status === "pending" ? null : "1");
  }, [status]);
  if (onboarding.isPending && !setUp) return null;
  if (status === "pending" && location.pathname !== "/welcome") {
    return <Navigate to="/welcome" replace />;
  }

  return (
    <OverlayOpenContext.Provider value={!!backgroundLocation}>
      <Routes location={backgroundLocation ?? location}>
        <Route
          path="/"
          element={
            // Steps through the image view leave the gallery's location as
            // it was: HoldRoute keeps them from re-rendering it.
            <HoldRoute>
              <App />
            </HoldRoute>
          }
        >
          <Route index element={<AllImagesPage />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="libraries" element={<LibrariesPage />} />
          <Route path="tags" element={<TagsPage />} />
          <Route path="tags/groups/:group" element={<TagGroupPage />} />
          <Route path="tags/:tag" element={<CharacterPage route="tag" />} />
          <Route path="characters/:tag" element={<CharacterPage />} />
          <Route path="ai-tagging" element={<AITaggingPage />} />
          <Route path="rules" element={<RulesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="generate" element={<GeneratePage />} />
          <Route path="generate/workflows/new" element={<WorkflowSetupPage />} />
          <Route path="generate/workflows/:id" element={<WorkflowSetupPage />} />
          <Route path="generations" element={<GenerationsPage />} />
          <Route path="generations/:id" element={<BatchPage />} />
          <Route path="outfits" element={<OutfitsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        <Route path="/image/:id" element={<ImageView />} />
        <Route
          path="/welcome"
          element={
            <Suspense fallback={null}>
              <WelcomePage />
            </Suspense>
          }
        />
      </Routes>
      {backgroundLocation && (
        <Routes>
          <Route path="/image/:id" element={<ImageView />} />
        </Routes>
      )}
      <ShortcutHelp />
    </OverlayOpenContext.Provider>
  );
}
