import { useLocation, useNavigate } from "react-router-dom";
import { withBackgroundLocation } from "../lib/backgroundLocation";
import { imageHref, type Filters } from "../lib/imageFilter";

/** Opens an image in the viewer over the current page, paging through the
 * images `filters` match. */
export function useOpenImage(filters: Filters) {
  const navigate = useNavigate();
  const location = useLocation();
  return (id: string) =>
    navigate(imageHref(id, filters), {
      state: withBackgroundLocation(location),
    });
}
