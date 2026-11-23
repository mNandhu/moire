import { memo } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { HoldRoute } from "./HoldRoute";

let renders = 0;
const Probe = memo(function Probe() {
  const loc = useLocation();
  renders++;
  return <p>{`${loc.pathname}|${JSON.stringify(loc.state)}`}</p>;
});

/** "/" under HoldRoute; `/image/:id` opened over it pins "/" as the
 * background, as RootRoutes does. */
function setup() {
  renders = 0;
  let navigate: NavigateFunction = () => {};
  function Root() {
    const loc = useLocation();
    navigate = useNavigate();
    const over = loc.pathname.startsWith("/image/");
    return (
      <Routes location={over ? { pathname: "/", search: "", hash: "" } : loc}>
        <Route
          path="/"
          element={
            <HoldRoute>
              <Probe />
            </HoldRoute>
          }
        />
      </Routes>
    );
  }
  render(
    <MemoryRouter>
      <Root />
    </MemoryRouter>,
  );
  // Each navigation in its own act, so its render has landed after.
  return (to: string | number, opts?: { replace?: boolean; state?: unknown }) =>
    act(() => {
      if (typeof to === "number") void navigate(to);
      else void navigate(to, opts);
    });
}

describe("HoldRoute", () => {
  it("holds the background location while the real one moves", () => {
    const go = setup();
    go("/image/a");
    const before = renders;
    go("/image/b", { replace: true });
    go("/image/c", { replace: true });
    expect(renders).toBe(before);
  });

  it("lets a navigation to the same path through, state included", () => {
    const go = setup();
    go("/", { state: { remix: 1 } });
    expect(screen.getByText('/|{"remix":1}')).toBeTruthy();
    go("/image/a");
    go(-1);
    expect(screen.getByText('/|{"remix":1}')).toBeTruthy();
    go("/", { state: null });
    expect(screen.getByText("/|null")).toBeTruthy();
  });
});
