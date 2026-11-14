import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { JsonTree, forcedBranches, matchesQuery } from "./GraphTree";

const graph = { a: { x: { p: 1 } }, b: { y: { q: 2 } } };

describe("JsonTree › toggling a branch", () => {
  it("collapses only the clicked branch", () => {
    render(<JsonTree value={graph} path="" onPin={() => {}} />);
    expect(screen.getByText(/x$/)).toBeTruthy();
    expect(screen.getByText(/y$/)).toBeTruthy();
    fireEvent.click(screen.getByText(/a$/));
    expect(screen.queryByText(/x$/)).toBeNull();
    expect(screen.getByText(/y$/)).toBeTruthy();
  });

  it("expands only the clicked branch below the default depth", () => {
    const deep = { r: { s: { a: { p: 1 }, b: { q: 2 } } } };
    render(<JsonTree value={deep} path="" onPin={() => {}} />);
    expect(screen.queryByText("p:")).toBeNull();
    fireEvent.click(screen.getByText(/^[▾▸] a$/));
    expect(screen.getByText("p:")).toBeTruthy();
    expect(screen.queryByText("q:")).toBeNull();
  });

  it("collapses a branch the search holds open", () => {
    const deep = { r: { s: { a: { p: 1 } } } };
    render(<JsonTree value={deep} path="" onPin={() => {}} query="p" />);
    expect(screen.getByText("p:")).toBeTruthy();
    fireEvent.click(screen.getByText(/^[▾▸] a$/));
    expect(screen.queryByText("p:")).toBeNull();
  });
});

describe("forcedBranches", () => {
  const tree = { r: { s: { a: { p: "Hello" } }, t: { u: 1 } }, "k.d": { z: { w: 2 } } };

  it("holds open the branches whose key or content matches", () => {
    expect([...forcedBranches(tree, "", "hello")].sort()).toEqual(["r", "r.s", "r.s.a"]);
    expect([...forcedBranches(tree, "", "Z")].sort()).toEqual(["k.d", "k.d.z"]);
    expect([...forcedBranches(tree, "", "k.d")]).toEqual(["k.d"]);
  });

  it("agrees with matchesQuery on every branch", () => {
    const got = forcedBranches(tree, "", "s");
    expect(got.has("r")).toBe(matchesQuery(tree.r, "s", "r"));
    expect(got.has("r.t")).toBe(matchesQuery(tree.r.t, "s", "t"));
    expect(got.has("r.s")).toBe(matchesQuery(tree.r.s, "s", "s"));
  });

  it("holds open the branches above a mark and none without a search", () => {
    const marks = new Map([["r.s.a.p", "prompt"]]);
    expect([...forcedBranches(tree, "", "", marks)].sort()).toEqual(["r", "r.s", "r.s.a"]);
    expect(forcedBranches(tree, "", "").size).toBe(0);
  });
});
