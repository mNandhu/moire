import { Suspense, lazy } from "react";
import { Navigate, Routes, Route, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { OverlayOpenContext, getBackgroundLocation } from "./lib/backgroundLocation";
import App from "./App";
import AllImagesPage from "./pages/AllImagesPage";
import ImageView from "./pages/ImageView";
import { useRefreshOnFinish } from "./hooks/useBackgroundTasks";
import { useTrackHistory } from "./hooks/useHistoryNav";
import { ONBOARDING_KEY, fetchOnboarding } from "./lib/onboarding";
import { ShortcutHelp } from "./components/ShortcutOverlay";

// Pages off the gallery's path load on first visit, so the first paint
// doesn't wait for Generate's code. The gallery and the image view (it opens
// over the gallery, instantly) stay in the main bundle.
const OverviewPage = lazy(() => import("./pages/OverviewPage"));
const LibrariesPage = lazy(() => import("./pages/LibrariesPage"));
const CharacterPage = lazy(() => import("./pages/CharacterPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const AITaggingPage = lazy(() => import("./pages/AITaggingPage"));
const RulesPage = lazy(() => import("./pages/RulesPage"));
const GeneratePage = lazy(() => import("./pages/GeneratePage"));
const GenerationsPage = lazy(() => import("./pages/GenerationsPage"));
const OutfitsPage = lazy(() => import("./pages/OutfitsPage"));
const WorkflowSetupPage = lazy(() => import("./pages/WorkflowSetupPage"));
const BatchPage = lazy(() => import("./pages/BatchPage"));
const WelcomePage = lazy(() => import("./pages/WelcomePage"));
const TagsPage = lazy(() => import("./pages/TagsPage"));
const TagGroupPage = lazy(() => import("./pages/TagsPage").then((m) => ({ default: m.TagGroupPage })));

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
  const onboarding = useQuery({
    queryKey: ONBOARDING_KEY,
    queryFn: ({ signal }) => fetchOnboarding(signal),
    staleTime: Infinity,
    retry: false,
  });
  if (onboarding.isPending) return null;
  if (onboarding.data?.status === "pending" && location.pathname !== "/welcome") {
    return <Navigate to="/welcome" replace />;
  }

  return (
    <OverlayOpenContext.Provider value={!!backgroundLocation}>
      <Routes location={backgroundLocation ?? location}>
        <Route path="/" element={<App />}>
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
