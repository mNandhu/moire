import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Picker } from "./Picker";
import { fuzzyScore } from "../../lib/fuzzy";

const embeddings = ["badhandv4", "lazypos", "negativeXL_D", "easynegative", "fFaceDetail", "bad-hands-5", "zPDXL3", "CyberRealistic_Negative-neg", "lazyneg"].map(
  (n) => ({ value: n, label: n, hint: "3" }),
);

describe("Picker", () => {
  it("fuzzy-finds an option from a sloppy query", () => {
    expect(fuzzyScore("bdhand", "badhandv4")).not.toBeNull();
    const onChange = vi.fn();
    render(<Picker aria-label="Embedding" value="" options={embeddings} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Embedding" }));
    fireEvent.change(screen.getByLabelText("Search options"), { target: { value: "bdhand" } });
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveTextContent("badhandv4");
    fireEvent.keyDown(screen.getByLabelText("Search options"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("badhandv4");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes on Escape without reaching the page's shortcuts", () => {
    const onPage = vi.fn();
    window.addEventListener("keydown", onPage);
    render(<Picker aria-label="Logic" value="and" options={[{ value: "and", label: "All" }, { value: "or", label: "Any" }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Logic" }));
    expect(screen.queryByLabelText("Search options")).not.toBeInTheDocument(); // short list
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onPage).not.toHaveBeenCalled();
    window.removeEventListener("keydown", onPage);
  });

  it("picks with the arrow keys and shows group headings", () => {
    const onChange = vi.fn();
    render(
      <Picker
        aria-label="Workflow"
        value=""
        onChange={onChange}
        options={[
          { value: "", label: "Any workflow" },
          { value: "w:1", label: "Remote, all 2 versions", group: "Remote" },
          { value: "s:a", label: "v1", group: "Remote", indent: true, keywords: "Remote" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Workflow" }));
    expect(screen.getByText("Remote")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("w:1");
  });
});
