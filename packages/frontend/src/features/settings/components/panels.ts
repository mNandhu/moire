// The settings panels, loaded together on first use (see `registry.tsx`):
// the search palette reads the registry at boot for the section names, and
// importing the panels there put every one of them in the main bundle.
export { TaggingSection } from "./sections/TaggingSection";
export { PromptTagsSection } from "./sections/PromptTagsSection";
export { BoilerplateSection } from "./sections/BoilerplateSection";
export { PromptGuessSection } from "./sections/PromptGuessSection";
export { CharactersSection } from "./sections/CharactersSection";
export { ComfySection } from "./sections/ComfySection";
export { TagColoursSection } from "./sections/TagColoursSection";
export { SensitivitySection } from "./sections/SensitivitySection";
export { AboutSection } from "@/features/update/components/AboutSection";
