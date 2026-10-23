import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { JsonTree } from "./GraphTree";

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
