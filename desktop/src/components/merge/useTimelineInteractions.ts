import { useCallback, useEffect, useRef } from "react";
import type { VideoMetadata } from "@/services/backend";
import type { MergeTextItem } from "@/stores/mergeStore";
import { clamp, normalizePath } from "./mergeFormat";
import { TimelineDragPreview } from "./TimelineDragPreview";
import {
  clipSourceEnd,
  resolveTimelineDragStart,
  sourceDurationForClip,
  timelineTimeFromClientX,
  type AudioClipLayout,
  type ClipLayout,
} from "./timelineModel";
import { useEventCallback } from "./useEventCallback";
type Ref<T> = {
  current: T;
};
type Commands = {
  beginHistoryTransaction: () => void;
  endHistoryTransaction: () => void;
  moveVideoTo: (
    id: string,
    start: number,
    trackId: string,
    record?: boolean,
  ) => void;
  updateVideo: (
    id: string,
    patch: Record<string, number>,
    record?: boolean,
  ) => void;
  updateAudio: (
    id: string,
    patch: Record<string, unknown>,
    record?: boolean,
  ) => void;
  updateText: (
    id: string,
    patch: Record<string, unknown>,
    record?: boolean,
  ) => void;
};
export function resolveTimelineDragCommit(
  requestedStart: number,
  duration: number,
  id: string,
  trackId: string,
  layouts: Array<ClipLayout | AudioClipLayout>,
  allowCrossTrackOverlap: boolean,
) {
  return resolveTimelineDragStart(
    requestedStart,
    duration,
    id,
    trackId,
    layouts,
    allowCrossTrackOverlap,
  );
}
export function useTimelineInteractions(options: {
  timelineRef: Ref<HTMLDivElement | null>;
  animationFrameRef: Ref<number | null>;
  timelineSeekFrameRef: Ref<number | null>;
  playheadDragFrameRef: Ref<number | null>;
  playheadRef: Ref<number>;
  totalDuration: number;
  pixelsPerSecond: number;
  frameStep: number;
  playing: boolean;
  videoTrackCount: number;
  audioTrackCount: number;
  clipLayouts: ClipLayout[];
  audioLayouts: AudioClipLayout[];
  metadata: Record<string, VideoMetadata>;
  draft: TimelineDragPreview;
  commands: Commands;
  scrub: (time: number, force?: boolean) => void;
  seek: (time: number, autoplay?: boolean) => void;
  setPlaying: (value: boolean) => void;
  setPlayheadDragging: (value: boolean) => void;
  setDraggedClipId: (value: string) => void;
  setDraggedAudioId: (value: string) => void;
  setDraggedTextId: (value: string) => void;
  setSelectedClipId: (value: string) => void;
  setSelectedAudioId: (value: string) => void;
  setSelectedTextId: (value: string) => void;
  clearClipMenu: () => void;
  clearAudioMenu: () => void;
  clearTextMenu: () => void;
}) {
  const current = useRef(options);
  useEffect(() => {
    current.current = options;
  }, [options]);
  const time = useCallback((x: number, rect: DOMRect) => {
    const o = current.current;
    return timelineTimeFromClientX(x, rect, o.totalDuration, o.pixelsPerSecond);
  }, []);
  const trackAt = useCallback(
    (x: number, y: number, kind: string) =>
      document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>(`[data-track-kind="${kind}"]`)?.dataset
        .trackId ?? null,
    [],
  );
  const scheduleSeek = useCallback(
    (x: number, rect: DOMRect) => {
      const o = current.current;
      const next = time(x, rect);
      if (o.timelineSeekFrameRef.current !== null)
        window.cancelAnimationFrame(o.timelineSeekFrameRef.current);
      o.timelineSeekFrameRef.current = window.requestAnimationFrame(() => {
        o.timelineSeekFrameRef.current = null;
        current.current.scrub(next);
      });
    },
    [time],
  );
  const playhead = useEventCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const o = current.current;
      if (event.button !== 0 || !o.timelineRef.current || !o.totalDuration)
        return;
      event.preventDefault();
      event.stopPropagation();
      let active = false;
      let x = event.clientX;
      const resume = o.playing;
      const update = () => {
        const c = current.current;
        if (!active) return;
        const rect = c.timelineRef.current?.getBoundingClientRect();
        if (rect) c.scrub(time(x, rect));
        c.playheadDragFrameRef.current = requestAnimationFrame(update);
      };
      const timer = setTimeout(() => {
        active = true;
        const c = current.current;
        c.setPlaying(false);
        c.setPlayheadDragging(true);
        c.playheadDragFrameRef.current = requestAnimationFrame(update);
      }, 240);
      const move = (e: PointerEvent) => {
        x = e.clientX;
      };
      const end = () => {
        const c = current.current;
        clearTimeout(timer);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (c.playheadDragFrameRef.current !== null)
          cancelAnimationFrame(c.playheadDragFrameRef.current);
        c.playheadDragFrameRef.current = null;
        if (active) {
          const rect = c.timelineRef.current?.getBoundingClientRect();
          if (rect) c.scrub(time(x, rect), true);
          if (resume) c.seek(c.playheadRef.current, true);
        }
        c.setPlayheadDragging(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
      window.addEventListener("pointercancel", end, { once: true });
    },
  );
  const timeline = useEventCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const o = current.current;
      if (
        event.button !== 0 ||
        !o.timelineRef.current ||
        !o.totalDuration ||
        (event.target as Element).closest(".timeline-clip-grip")
      )
        return;
      event.preventDefault();
      o.setSelectedAudioId("");
      o.setSelectedTextId("");
      const rect = o.timelineRef.current.getBoundingClientRect();
      const resume = o.playing;
      if (resume) o.setPlaying(false);
      let latest = time(event.clientX, rect);
      const move = (e: PointerEvent) => {
        latest = time(e.clientX, rect);
        if (o.timelineSeekFrameRef.current === null)
          o.timelineSeekFrameRef.current = requestAnimationFrame(() => {
            o.timelineSeekFrameRef.current = null;
            current.current.scrub(latest);
          });
      };
      const end = (e: PointerEvent) => {
        latest = time(e.clientX, rect);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (o.timelineSeekFrameRef.current !== null)
          cancelAnimationFrame(o.timelineSeekFrameRef.current);
        o.timelineSeekFrameRef.current = null;
        o.scrub(latest, true);
        if (resume) o.seek(latest, true);
      };
      move(event.nativeEvent);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
      window.addEventListener("pointercancel", end, { once: true });
    },
  );
  const video = useEventCallback(
    (event: React.PointerEvent, layout: ClipLayout) => {
      const o = current.current;
      if (event.button !== 0 || !o.timelineRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      o.setSelectedAudioId("");
      o.setSelectedTextId("");
      o.setSelectedClipId(layout.item.id);
      o.clearClipMenu();
      o.clearAudioMenu();
      const startX = event.clientX;
      let x = startX,
        y = event.clientY,
        long = false,
        scrubbed = false;
      const resume = o.playing;
      const offset =
        time(x, o.timelineRef.current.getBoundingClientRect()) - layout.start;
      const timer = setTimeout(() => {
        long = true;
        const c = current.current;
        if (resume) c.setPlaying(false);
        c.commands.beginHistoryTransaction();
        c.setDraggedClipId(layout.item.id);
      }, 320);
      const next = () => {
        const c = current.current;
        const rect = c.timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        const track = trackAt(x, y, "video") ?? layout.trackId;
        return resolveTimelineDragCommit(
          time(x, rect) - offset,
          layout.duration,
          layout.item.id,
          track,
          c.clipLayouts,
          c.videoTrackCount > 1,
        );
      };
      const move = (e: PointerEvent) => {
        x = e.clientX;
        y = e.clientY;
        if (long) {
          if (o.animationFrameRef.current !== null)
            cancelAnimationFrame(o.animationFrameRef.current);
          o.animationFrameRef.current = requestAnimationFrame(() => {
            o.animationFrameRef.current = null;
            const start = next();
            if (start !== undefined)
              current.current.draft.set({
                id: layout.item.id,
                kind: "video",
                start,
              });
          });
          return;
        }
        if (Math.abs(x - startX) < 4) return;
        scrubbed = true;
        clearTimeout(timer);
        if (resume) o.setPlaying(false);
        const rect = o.timelineRef.current?.getBoundingClientRect();
        if (rect) scheduleSeek(x, rect);
      };
      const end = (e: PointerEvent) => {
        x = e.clientX;
        clearTimeout(timer);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        const c = current.current;
        if (long) {
          if (c.animationFrameRef.current !== null)
            cancelAnimationFrame(c.animationFrameRef.current);
          c.animationFrameRef.current = null;
          const start = next();
          if (start !== undefined)
            c.commands.moveVideoTo(
              layout.item.id,
              start,
              trackAt(x, y, "video") ?? layout.trackId,
              false,
            );
          c.commands.endHistoryTransaction();
          c.setDraggedClipId("");
          c.draft.set(null);
          return;
        }
        if (c.timelineSeekFrameRef.current !== null)
          cancelAnimationFrame(c.timelineSeekFrameRef.current);
        c.timelineSeekFrameRef.current = null;
        const rect = c.timelineRef.current?.getBoundingClientRect();
        const nextTime = rect ? time(x, rect) : c.playheadRef.current;
        c.scrub(nextTime, true);
        if (scrubbed && resume) c.seek(nextTime, true);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
      window.addEventListener("pointercancel", end, { once: true });
    },
  );
  const trim = useEventCallback(
    (event: React.PointerEvent, layout: ClipLayout, edge: "start" | "end") => {
      const o = current.current;
      if (event.button !== 0 || !o.timelineRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      o.setSelectedAudioId("");
      o.setSelectedTextId("");
      o.setSelectedClipId(layout.item.id);
      const rect = o.timelineRef.current.getBoundingClientRect(),
        sec = o.totalDuration
          ? o.totalDuration / Math.max(1, rect.width)
          : o.frameStep,
        origin = event.clientX,
        info = o.metadata[normalizePath(layout.item.path)],
        source = sourceDurationForClip(layout.item, info),
        startTrim = layout.item.trimStart,
        endSource = clipSourceEnd(layout.item, info),
        min = o.frameStep;
      let latest: PointerEvent | null = null,
        frame: number | null = null;
      o.commands.beginHistoryTransaction();
      const values = (e: PointerEvent) => {
        const d = (e.clientX - origin) * sec;
        if (edge === "start") {
          const t = clamp(startTrim + d, 0, endSource - min);
          return {
            trimStart: t,
            startTime: Math.max(0, layout.start + t - startTrim),
            duration: Math.max(min, endSource - t),
          };
        }
        const t = clamp(endSource + d, startTrim + min, source);
        return {
          trimEnd: t,
          startTime: layout.start,
          duration: Math.max(min, t - startTrim),
        };
      };
      const move = (e: PointerEvent) => {
        latest = e;
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (latest) {
            const v = values(latest);
            current.current.draft.set({
              id: layout.item.id,
              kind: "video",
              start: v.startTime,
              duration: v.duration,
            });
          }
        });
      };
      const end = (e: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (frame !== null) cancelAnimationFrame(frame);
        const value = values(e);
        const patch =
          edge === "start"
            ? { trimStart: value.trimStart, startTime: value.startTime }
            : { trimEnd: value.trimEnd };
        o.commands.updateVideo(layout.item.id, patch, false);
        o.commands.endHistoryTransaction();
        o.draft.set(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
      window.addEventListener("pointercancel", end, { once: true });
    },
  );
  function dragMedia(
    event: React.PointerEvent,
    layout: {
      item: { id: string };
      trackId: string;
      start: number;
      duration: number;
    },
    kind: "audio" | "text",
  ) {
    const o = current.current;
    if (event.button !== 0 || !o.timelineRef.current || !o.totalDuration)
      return;
    event.preventDefault();
    event.stopPropagation();
    const id = layout.item.id;
    o.setSelectedClipId("");
    if (kind === "audio") {
      o.setSelectedTextId("");
      o.setSelectedAudioId(id);
      o.clearClipMenu();
      o.clearAudioMenu();
    } else {
      o.setSelectedAudioId("");
      o.setSelectedTextId(id);
      o.clearClipMenu();
      o.clearAudioMenu();
      o.clearTextMenu();
    }
    const offset =
      time(event.clientX, o.timelineRef.current.getBoundingClientRect()) -
      layout.start;
    let long = false,
      x = event.clientX,
      y = event.clientY;
    const timer = setTimeout(
      () => {
        long = true;
        const c = current.current;
        c.commands.beginHistoryTransaction();
        if (kind === "audio") c.setDraggedAudioId(id);
        else c.setDraggedTextId(id);
      },
      kind === "audio" ? 320 : 260,
    );
    const start = () => {
      const c = current.current,
        rect = c.timelineRef.current?.getBoundingClientRect();
      if (!rect) return;
      const track = trackAt(x, y, kind) ?? layout.trackId;
      const requested = time(x, rect) - offset;
      return kind === "text"
        ? clamp(requested, 0, c.totalDuration)
        : resolveTimelineDragCommit(
            requested,
            layout.duration,
            id,
            track,
            c.audioLayouts,
            c.audioTrackCount > 1,
          );
    };
    const move = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!long) return;
      if (o.animationFrameRef.current !== null)
        cancelAnimationFrame(o.animationFrameRef.current);
      o.animationFrameRef.current = requestAnimationFrame(() => {
        o.animationFrameRef.current = null;
        const next = start();
        if (next !== undefined)
          current.current.draft.set({ id, kind, start: next });
      });
    };
    const end = () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const c = current.current;
      if (c.animationFrameRef.current !== null)
        cancelAnimationFrame(c.animationFrameRef.current);
      c.animationFrameRef.current = null;
      if (long) {
        const next = start();
        const track = trackAt(x, y, kind) ?? layout.trackId;
        if (next !== undefined) {
          if (kind === "audio")
            c.commands.updateAudio(
              id,
              { startTime: next, trackId: track },
              false,
            );
          else
            c.commands.updateText(
              id,
              { startTime: next, trackId: track },
              false,
            );
        }
        c.commands.endHistoryTransaction();
      }
      if (kind === "audio") c.setDraggedAudioId("");
      else c.setDraggedTextId("");
      c.draft.set(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  }
  const audio = useEventCallback(
    (event: React.PointerEvent, layout: AudioClipLayout) =>
      dragMedia(event, layout, "audio"),
  );
  const text = useEventCallback(
    (event: React.PointerEvent, item: MergeTextItem) =>
      dragMedia(
        event,
        {
          item,
          trackId: item.trackId,
          start: item.startTime,
          duration: item.duration,
        },
        "text",
      ),
  );
  return {
    handlePlayheadPointerDown: playhead,
    handleTimelinePointerDown: timeline,
    handleVideoPointerDown: video,
    handleVideoTrimPointerDown: trim,
    handleAudioPointerDown: audio,
    handleTextPointerDown: text,
  };
}
