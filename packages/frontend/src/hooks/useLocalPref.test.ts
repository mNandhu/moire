import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { KEY_SET, useLocalPref } from "./useLocalPref";
import { readLocalPref, writeLocalPref } from "../lib/localPref";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("useLocalPref", () => {
  it("reads the default, then a stored value, with the type's codec", () => {
    localStorage.setItem("t:bool", "1");
    const bool = renderHook(() => useLocalPref("t:bool", false));
    expect(bool.result.current[0]).toBe(true);
    const str = renderHook(() => useLocalPref("t:str", "grid"));
    expect(str.result.current[0]).toBe("grid");
    act(() => str.result.current[1]("list"));
    expect(str.result.current[0]).toBe("list");
    expect(localStorage.getItem("t:str")).toBe("list");
    act(() => bool.result.current[1](false));
    expect(localStorage.getItem("t:bool")).toBe("0");
  });

  it("never writes the default back on its own", () => {
    renderHook(() => useLocalPref("t:untouched", 3));
    expect(localStorage.getItem("t:untouched")).toBeNull();
  });

  it("keeps two consumers of one key in step, and takes an updater", () => {
    const a = renderHook(() => useLocalPref("t:n", 5));
    const b = renderHook(() => useLocalPref("t:n", 5));
    act(() => a.result.current[1]((n) => n + 1));
    expect(b.result.current[0]).toBe(6);
  });

  it("follows another tab's storage event", () => {
    const a = renderHook(() => useLocalPref("t:x", "a"));
    localStorage.setItem("t:x", "b");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "t:x" }));
    });
    expect(a.result.current[0]).toBe("b");
  });

  it("falls back to the default on an unusable stored value", () => {
    localStorage.setItem("t:n", "abc");
    const n = renderHook(() => useLocalPref("t:n", 2));
    expect(n.result.current[0]).toBe(2);
    localStorage.setItem("t:set", "{not json");
    const set = renderHook(() => useLocalPref<Set<string>>("t:set", new Set(), KEY_SET));
    expect(set.result.current[0].size).toBe(0);
  });

  it("round-trips a Set through its JSON array", () => {
    const h = renderHook(() => useLocalPref<Set<string>>("t:set2", new Set(), KEY_SET));
    act(() => h.result.current[1]((s) => new Set([...s, "a"])));
    expect(localStorage.getItem("t:set2")).toBe('["a"]');
    expect([...h.result.current[0]]).toEqual(["a"]);
  });

  it("survives a localStorage that throws, holding the choice in memory", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const h = renderHook(() => useLocalPref("t:blocked", false));
    expect(h.result.current[0]).toBe(false);
    act(() => h.result.current[1](true));
    expect(h.result.current[0]).toBe(true);
  });
});

describe("readLocalPref / writeLocalPref", () => {
  it("null removes the key", () => {
    writeLocalPref("t:r", "1");
    expect(readLocalPref("t:r")).toBe("1");
    writeLocalPref("t:r", null);
    expect(readLocalPref("t:r")).toBeNull();
  });
});
