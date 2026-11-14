import { MapPinOff } from "lucide-react";
import { ButtonLink, EmptyState } from "@/components/ui";

/** Any address no page answers (a typo, an old bookmark). */
export default function NotFoundPage() {
  return (
    <EmptyState
      icon={MapPinOff}
      title="Page not found"
      actions={<ButtonLink to="/">All Images</ButtonLink>}
    />
  );
}
