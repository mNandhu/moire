import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { JsonTree, matchesQuery, collectMatches } from "../components/GraphTree";

// The load-bearing, silent-on-failure interaction: clicking a tree leaf must
// build the dot-path rooted at the raw doc (so pins read `prompt.<n>.inputs.<w>`
// and resolve_path on the backend hits the same value). A wrong root or an
// off-by-one in the array branch fails silently (extraction just stays null).
describe("JsonTree path construction", () => {
  it("dict-key leaf yields the rooted dot-path", () => {
    const onPin = vi.fn();
    render(
      <JsonTree
        value={{ prompt: { inputs: { text0: "a knight" } } }}
        path=""
        onPin={onPin}
      />,
    );
    fireEvent.click(screen.getByText('"a knight"'));
    expect(onPin).toHaveBeenCalledWith("prompt.inputs.text0");
  });

  it("array element leaf yields a numeric index segment", () => {
    const onPin = vi.fn();
    render(<JsonTree value={{ positive: ["6", 0] }} path="prompt.3.inputs" onPin={onPin} />);
    fireEvent.click(screen.getByText('"6"'));
    expect(onPin).toHaveBeenCalledWith("prompt.3.inputs.positive.0");
  });
});

describe("matchesQuery", () => {
  const graph = {
    "34": { class_type: "CLIPTextEncode", inputs: { text: "masterpiece, 1girl" } },
  };
  it("matches a node id (key)", () => expect(matchesQuery(graph, "34")).toBe(true));
  it("matches a class_type value", () =>
    expect(matchesQuery(graph, "cliptextencode")).toBe(true));
  it("matches a buried prompt word", () =>
    expect(matchesQuery(graph, "MASTERPIECE")).toBe(true));
  it("misses an absent token", () =>
    expect(matchesQuery(graph, "ksampler")).toBe(false));
  it("empty query never matches", () => expect(matchesQuery(graph, "  ")).toBe(false));
});

describe("collectMatches surfaces pinnable rows", () => {
  // Mirrors the real graph: the prompt word is buried in a node's text widget.
  const graph = {
    prompt: {
      "32": {
        class_type: "CLIPTextEncode",
        inputs: { text_0: "lazypos, masterpiece, anime", clip: ["4", 1] },
      },
      "37": { inputs: { text: "masterpiece quality" } },
    },
  };

  it("finds the value buried in a key and reports its rooted dot-path", () => {
    const m = collectMatches(graph, "masterpiece");
    const paths = m.map((x) => x.path);
    expect(paths).toContain("prompt.32.inputs.text_0");
    expect(paths).toContain("prompt.37.inputs.text");
    expect(paths).not.toContain("prompt.32.inputs.clip.0"); // non-matching leaf
  });

  it("matches a key (node id / widget name) too", () => {
    expect(collectMatches(graph, "text_0").map((x) => x.path)).toContain(
      "prompt.32.inputs.text_0",
    );
  });

  it("empty query yields nothing", () =>
    expect(collectMatches(graph, "  ")).toEqual([]));
});

describe("JsonTree search reveals the matching node", () => {
  // The tree collapses at depth >= 2; a search must force the branch open so the
  // matched node's id AND class_type are both visible (not pruned).
  const graph = {
    prompt: {
      "34": { class_type: "CLIPTextEncode", inputs: { text: "masterpiece" } },
    },
  };

  it("a deep prompt value is collapsed (hidden) without a query", () => {
    render(<JsonTree value={graph} path="" onPin={vi.fn()} />);
    expect(screen.queryByText('"masterpiece"')).toBeNull();
  });

  it("searching a prompt word force-opens to show the value + its class_type", () => {
    render(<JsonTree value={graph} path="" onPin={vi.fn()} query="masterpiece" />);
    // The matched value is revealed, and the node's class_type stays in context.
    expect(screen.getByText('"masterpiece"')).toBeTruthy();
    expect(screen.getByText('"CLIPTextEncode"')).toBeTruthy();
  });

  it("leaves carry data-graph-path so a match row can scroll to them", () => {
    const { container } = render(
      <JsonTree value={graph} path="" onPin={vi.fn()} query="masterpiece" />,
    );
    expect(
      container.querySelector('[data-graph-path="prompt.34.inputs.text"]'),
    ).toBeTruthy();
  });
});
