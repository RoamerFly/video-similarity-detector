import { describe, expect, it } from "vitest";
import type { ClipLayout } from "./timelineModel";
import { resolveTimelineDragCommit } from "./useTimelineInteractions";

function layout(
  id: string,
  trackId: string,
  start: number,
  duration: number,
): ClipLayout {
  return {
    item: { id },
    trackId,
    start,
    duration,
    end: start + duration,
  } as unknown as ClipLayout;
}

describe("resolveTimelineDragCommit", () => {
  const layouts = [
    layout("moving", "video-1", 0, 2),
    layout("occupied", "video-1", 2, 3),
  ];

  it("prevents overlap when dragging within a single-track timeline", () => {
    const resolved = resolveTimelineDragCommit(
      2.5,
      2,
      "moving",
      "video-1",
      layouts,
      false,
    );

    expect(resolved).toBe(0);
    expect(resolved + 2 <= 2 || resolved >= 5).toBe(true);
  });

  it("allows the requested position when dragging between video tracks", () => {
    expect(
      resolveTimelineDragCommit(2.5, 2, "moving", "video-2", layouts, true),
    ).toBe(2.5);
  });
});
