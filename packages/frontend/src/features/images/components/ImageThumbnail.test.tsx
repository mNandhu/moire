import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageThumbnail } from "./ImageThumbnail";
import { resetSeenThumbnails } from "@/features/images/hooks/useImageLoadSlot";

describe("ImageThumbnail", () => {
  beforeEach(() => resetSeenThumbnails());

  it("decodes a seen image synchronously so it cannot paint an empty tile", () => {
    const first = render(<ImageThumbnail src="a.webp" alt="tile" eager />);
    const img = screen.getByAltText("tile");
    expect(img.getAttribute("decoding")).toBe("async");
    fireEvent.load(img);
    first.unmount();

    render(<ImageThumbnail src="a.webp" alt="tile" eager />);
    expect(screen.getByAltText("tile").getAttribute("decoding")).toBe("sync");
  });
});
