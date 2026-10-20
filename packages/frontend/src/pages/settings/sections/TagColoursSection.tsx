import { Section } from "../../../components/ui/Card";
import { Checkbox } from "../../../components/ui/Checkbox";
import { setTagMarks, useTagMarks } from "../../../hooks/useTagMarks";

/**
 * How tag lists mark tags: hair and eye colours as outlines, and a tint per
 * kind of tag. Kept on this device and applied at once.
 */
export function TagColoursSection() {
  const marks = useTagMarks();
  return (
    <Section title="Tag colours" description="Applies right away, on this device.">
      <div className="space-y-3">
        <Checkbox
          id="tag_outlines"
          checked={marks.outlines}
          onChange={(v) => setTagMarks({ outlines: v })}
          label="Outline hair and eye tags in their colour"
          hint="red hair gets a red outline, heterochromia a rainbow one. In the image view, on character pages and in Generate."
        />
        <Checkbox
          id="tag_tints"
          checked={marks.tints}
          onChange={(v) => setTagMarks({ tints: v })}
          label="Tint tags by kind"
          hint="A faint wash for look, outfit, pose and expression, scene and framing, in the image view's tag list."
        />
      </div>
    </Section>
  );
}
