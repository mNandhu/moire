import { useLocation, useNavigate } from "react-router-dom";
import { withBackgroundLocation } from "@/lib/backgroundLocation";
import { contextState } from "@/lib/viewContext";
import { imageHref, type Filters } from "@/features/images/lib/imageFilter";

/** Opens an image in the viewer over the current page, paging through the
 * images `filters` match; `context` names them in the view's corner. */
export function useOpenImage(filters: Filters, context?: string) {
  const navigate = useNavigate();
  const location = useLocation();
  return (id: string) =>
    navigate(imageHref(id, filters), {
      state: { ...withBackgroundLocation(location), ...contextState(context) },
    });
}
