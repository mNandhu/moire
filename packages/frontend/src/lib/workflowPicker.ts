import type { WorkflowFamily } from "./workflows";

/**
 * The gallery's workflow filter picker: a family (every version, new ones
 * included) or one version, named as on the Rules page. Values are
 * `w:<family id>` or `s:<signature>`; "" is any workflow.
 */
export type WorkflowPickerOption<H> = {
  value: string;
  label: string;
  hint?: H;
  group?: string;
  indent?: boolean;
  keywords?: string;
};

/**
 * Picker rows for `families`: a family row when it has an id, then its
 * versions (indented under it) when there are several or it has no id.
 * `hint(count, inGenerate)` draws each row's count; `inGenerate` says whether
 * a Generator is set up from that family or version.
 */
export function workflowPickerOptions<H>(
  families: WorkflowFamily[],
  inGenerate: (key: { family?: string; sig?: string }) => boolean,
  hint: (count: number, inGenerate: boolean) => H,
): WorkflowPickerOption<H>[] {
  return [
    { value: "", label: "Any workflow" },
    ...families.flatMap((fam) => [
      ...(fam.id
        ? [
            {
              value: `w:${fam.id}`,
              label: fam.versions.length > 1 ? `${fam.name}, all ${fam.versions.length} versions` : fam.name,
              hint: hint(fam.images, inGenerate({ family: fam.id })),
              group: fam.name,
            },
          ]
        : []),
      ...(fam.versions.length > 1 || !fam.id
        ? fam.versions.map((v) => ({
            value: `s:${v.row.workflow_sig}`,
            label: v.note ? `${v.title} · ${v.note}` : v.title,
            hint: hint(v.row.count, inGenerate({ sig: v.row.workflow_sig })),
            group: fam.name,
            indent: !!fam.id,
            keywords: fam.name,
          }))
        : []),
    ]),
  ];
}

/** The picker value for a filter's workflow / workflowSig. */
export function workflowPickerValue(f: { workflow?: string; workflowSig?: string }): string {
  return f.workflow ? `w:${f.workflow}` : f.workflowSig ? `s:${f.workflowSig}` : "";
}

/** The filter fields a picker value selects. */
export function workflowFromPickerValue(v: string): { workflow: string | undefined; workflowSig: string | undefined } {
  return {
    workflow: v.startsWith("w:") ? v.slice(2) : undefined,
    workflowSig: v.startsWith("s:") ? v.slice(2) : undefined,
  };
}
