import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { PromptInput } from "./PromptInput";

function Field({ initial, onChange }: { initial: string; onChange: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <PromptInput
      label="Prompt"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
      suggestions={[]}
      embeddings={[]}
    />
  );
}

describe("PromptInput weight keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("raises and lowers the term at the caret with Ctrl+Up / Ctrl+Down", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
    const onChange = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Field initial="1girl, smile" onChange={onChange} />
      </QueryClientProvider>,
    );
    const box = screen.getByRole("combobox", { name: "Prompt" }) as HTMLTextAreaElement;
    box.setSelectionRange(9, 9);
    fireEvent.keyDown(box, { key: "ArrowUp", ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith("1girl, (smile:1.05)");
    box.setSelectionRange(9, 9);
    fireEvent.keyDown(box, { key: "ArrowDown", ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith("1girl, smile");
    // A plain arrow is the caret's.
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
