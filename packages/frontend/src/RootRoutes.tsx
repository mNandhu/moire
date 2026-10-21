import { Routes, Route, useLocation } from "react-router-dom";
import { OverlayOpenContext, getBackgroundLocation } from "./lib/backgroundLocation";
import App from "./App";
import OverviewPage from "./pages/OverviewPage";
import AllImagesPage from "./pages/AllImagesPage";
import LibrariesPage from "./pages/LibrariesPage";
import TagsPage from "./pages/TagsPage";
import CharacterPage from "./pages/CharacterPage";
import SettingsPage from "./pages/SettingsPage";
import AITaggingPage from "./pages/AITaggingPage";
import RulesPage from "./pages/RulesPage";
import ImageView from "./pages/ImageView";
import { useRefreshOnFinish } from "./hooks/useBackgroundTasks";
import { useTrackHistory } from "./hooks/useHistoryNav";
import GeneratePage from "./pages/GeneratePage";
import GenerationsPage from "./pages/GenerationsPage";
import OutfitsPage from "./pages/OutfitsPage";
import WorkflowSetupPage from "./pages/WorkflowSetupPage";
import BatchPage from "./pages/BatchPage";

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

  return (
    <OverlayOpenContext.Provider value={!!backgroundLocation}>
      <Routes location={backgroundLocation ?? location}>
        <Route path="/" element={<App />}>
          <Route index element={<AllImagesPage />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="libraries" element={<LibrariesPage />} />
          <Route path="tags" element={<TagsPage />} />
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
      </Routes>
      {backgroundLocation && (
        <Routes>
          <Route path="/image/:id" element={<ImageView />} />
        </Routes>
      )}
    </OverlayOpenContext.Provider>
  );
}
