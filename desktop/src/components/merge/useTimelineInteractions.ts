import { useCallback, useEffect, useRef } from "react";
import type { VideoMetadata } from "@/services/backend";
import type { MergeTextItem } from "@/stores/mergeStore";
import { clamp, normalizePath } from "./mergeFormat";
import { TimelineDragPreview, type TimelineDragPreviewValue } from "./TimelineDragPreview";
import {
  clipSourceEnd,
  resolveTimelineDragStart,
  sourceDurationForClip,
  timelineTimeFromClientX,
  type AudioClipLayout,
  type ClipLayout,
} from "./timelineModel";
import { transitionTimelineGesture, type TimelineGestureEvent, type TimelineGesturePhase } from "./timelineGesture";
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
    exchangeStart?: number,
    exchangeTargetId?: string | null,
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
  moveAudioTo: (
    id: string,
    start: number,
    trackId: string,
    record?: boolean,
    exchangeStart?: number,
    exchangeTargetId?: string | null,
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
  audioDurations?: Record<string, number>;
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
  const activeGestureCleanup = useRef<(() => void) | null>(null);
  const draftSettleTimer = useRef<number | null>(null);
  useEffect(() => {
    current.current = options;
  }, [options]);
  useEffect(() => () => {
    activeGestureCleanup.current?.();
    activeGestureCleanup.current = null;
    if (draftSettleTimer.current !== null) window.clearTimeout(draftSettleTimer.current);
    draftSettleTimer.current = null;
    current.current.draft.set(null);
  }, []);
  const clearDraftSettle = useCallback(() => {
    if (draftSettleTimer.current !== null) window.clearTimeout(draftSettleTimer.current);
    draftSettleTimer.current = null;
  }, []);
  const settleDraft = useCallback((value: Exclude<TimelineDragPreviewValue, null>, phase: 'settling' | 'reverting', pointerX: number, pointerY: number) => {
    clearDraftSettle();
    const reduced = typeof window === 'undefined'
      || typeof window.matchMedia !== 'function'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      current.current.draft.set(null);
      return;
    }
    current.current.draft.set({ ...value, pointerX, pointerY, phase });
    draftSettleTimer.current = window.setTimeout(() => {
      draftSettleTimer.current = null;
      current.current.draft.set(null);
    }, phase === 'settling' ? 150 : 130);
  }, [clearDraftSettle]);
  const time = useCallback((x: number, rect: DOMRect) => {
    const o = current.current;
    return timelineTimeFromClientX(x, rect, o.totalDuration, o.pixelsPerSecond);
  }, []);
  /**
   * Pointer capture keeps the source button as the event target while a
   * drag is in progress.  `elementFromPoint` is not guaranteed to return the
   * element below the pointer in every embedded WebView, so use the complete
   * hit stack first and fall back to geometry.  Losing a hit for one frame
   * must not turn a valid drop into a no-op.
   */
  const elementsAt = useCallback((x: number, y: number): Element[] => {
    if (typeof document === 'undefined' || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    if (typeof document.elementsFromPoint === 'function') return document.elementsFromPoint(x, y);
    const element = document.elementFromPoint(x, y);
    return element ? [element] : [];
  }, []);
  const trackAt = useCallback(
    (x: number, y: number, kind: string) => {
      const selector = `[data-track-kind="${kind}"]`;
      for (const element of elementsAt(x, y)) {
        const track = element.closest<HTMLElement>(selector);
        if (track?.dataset.trackId) return track.dataset.trackId;
      }
      // A pointer can be released a few pixels outside the captured element
      // (especially after scrolling).  The track rectangle is still a valid
      // drop target in that case.
      const tracks = document.querySelectorAll<HTMLElement>(selector);
      for (const track of Array.from(tracks)) {
        const rect = track.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
          return track.dataset.trackId ?? null;
      }
      return null;
    },
    [elementsAt],
  );
  const clipAt = useCallback(
    (x: number, y: number, kind: string) => {
      const trackSelector = `[data-track-kind="${kind}"]`;
      for (const element of elementsAt(x, y)) {
        const clip = element.closest<HTMLElement>(`${trackSelector} [data-clip-id]`);
        if (clip?.dataset.clipId) return clip.dataset.clipId;
      }
      // Geometry fallback is deliberately limited to clips on the requested
      // track kind, avoiding stale/overlapping DOM nodes from other rows.
      const clips = document.querySelectorAll<HTMLElement>(`${trackSelector} [data-clip-id]`);
      for (const clip of Array.from(clips)) {
        const rect = clip.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
          return clip.dataset.clipId ?? null;
      }
      return null;
    },
    [elementsAt],
  );
  const trackRectAt = useCallback((kind: string, trackId: string) => {
    const tracks = document.querySelectorAll<HTMLElement>(`[data-track-kind="${kind}"]`);
    for (const track of Array.from(tracks)) {
      if (track.dataset.trackId === trackId) return track.getBoundingClientRect();
    }
    return null;
  }, []);
  const snappedOverlayPoint = useCallback((kind: string, trackId: string, start: number, grabOffsetX: number, grabOffsetY: number) => {
    const c = current.current;
    const timelineRect = c.timelineRef.current?.getBoundingClientRect();
    const trackRect = trackRectAt(kind, trackId);
    return {
      x: (timelineRect?.left ?? 0) + start * c.pixelsPerSecond + grabOffsetX,
      y: (trackRect?.top ?? 0) + 4 + grabOffsetY,
    };
  }, [trackRectAt]);
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
      activeGestureCleanup.current?.();
      const startX = event.clientX;
      let x = startX,
        y = event.clientY,
        phase: TimelineGesturePhase = transitionTimelineGesture("idle", "pointerdown");
      const resume = o.playing;
      const pointerId = event.pointerId;
      const captureTarget = event.currentTarget as HTMLElement;
      const clipRect = captureTarget.getBoundingClientRect();
      const grabOffsetX = event.clientX - clipRect.left;
      const grabOffsetY = event.clientY - clipRect.top;
      try { captureTarget.setPointerCapture(pointerId); } catch { /* capture can fail after unmount */ }
      const offset =
        time(x, o.timelineRef.current.getBoundingClientRect()) - layout.start;
      const releaseCapture = () => {
        try {
          if (captureTarget.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId);
        } catch { /* pointer already released */ }
      };
      const timer = setTimeout(() => {
        if (phase !== "pending") return;
        phase = transitionTimelineGesture(phase, "longpress");
        const c = current.current;
        if (resume) c.setPlaying(false);
        c.commands.beginHistoryTransaction();
        c.setDraggedClipId(layout.item.id);
        const initial = nextPosition();
        if (initial) c.draft.set({
          id: layout.item.id,
          kind: "video",
          label: layout.item.name,
          duration: layout.duration,
          height: clipRect.height,
          pointerX: x,
          pointerY: y,
          grabOffsetX,
          grabOffsetY,
          phase: "dragging",
          ...initial,
        });
      }, 320);
      type DragPosition = {
        start: number;
        trackId: string;
        targetClipId: string | null;
        valid: boolean;
      };
      let lastValidPosition: DragPosition | null = null;
      const nextPosition = () => {
        const c = current.current;
        const rect = c.timelineRef.current?.getBoundingClientRect();
        if (!rect) return;
        const targetTrack = trackAt(x, y, "video");
        const track = targetTrack ?? layout.trackId;
        const hitClip = clipAt(x, y, "video");
        const targetClipId = hitClip === layout.item.id ? null : hitClip;
        const start = resolveTimelineDragCommit(
          time(x, rect) - offset,
          layout.duration,
          layout.item.id,
          track,
          c.clipLayouts,
          c.videoTrackCount > 1,
        );
        const position = { start, trackId: track, targetClipId, valid: Boolean(targetTrack) };
        if (position.valid) lastValidPosition = position;
        return position;
      };
      const requestedStart = () => {
        const c = current.current;
        const rect = c.timelineRef.current?.getBoundingClientRect();
        return rect ? time(x, rect) - offset : undefined;
      };
      const move = (e: PointerEvent) => {
        x = e.clientX;
        y = e.clientY;
        if (phase === "dragging") {
          if (o.animationFrameRef.current !== null)
            cancelAnimationFrame(o.animationFrameRef.current);
          o.animationFrameRef.current = requestAnimationFrame(() => {
            o.animationFrameRef.current = null;
            const position = nextPosition();
            if (position) current.current.draft.set({
              id: layout.item.id,
              kind: "video",
              label: layout.item.name,
              duration: layout.duration,
              height: clipRect.height,
              pointerX: x,
              pointerY: y,
              grabOffsetX,
              grabOffsetY,
              phase: "dragging",
              ...position,
            });
          });
          return;
        }
        // A clip gesture stays pending until long-press. Pointer jitter and
        // quick drags must never hijack the timeline scrub interaction.
        if (phase === "pending") phase = transitionTimelineGesture(phase, "move");
      };
      let finished = false;
      const end = (e?: PointerEvent, reason: TimelineGestureEvent = "pointerup") => {
        if (finished) return;
        finished = true;
        if (e) {
          x = e.clientX;
          y = e.clientY;
        }
        const wasDragging = phase === "dragging";
        phase = transitionTimelineGesture(phase, reason);
        clearTimeout(timer);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("blur", onBlur);
        releaseCapture();
        const c = current.current;
        if (activeGestureCleanup.current === cleanup) activeGestureCleanup.current = null;
        if (wasDragging && reason === "pointerup") {
          if (c.animationFrameRef.current !== null)
            cancelAnimationFrame(c.animationFrameRef.current);
          c.animationFrameRef.current = null;
          // Pointer capture can make the final hit-test transiently miss the
          // track.  Keep the last confirmed target so a valid exchange/move
          // is still committed instead of silently reverting.
          const position = nextPosition();
          const commitPosition = position?.valid ? position : lastValidPosition;
          const value = c.draft.getSnapshot() ?? {
            id: layout.item.id,
            kind: 'video' as const,
            start: layout.start,
            duration: layout.duration,
            label: layout.item.name,
            grabOffsetX,
            grabOffsetY,
            pointerX: x,
            pointerY: y,
          };
          if (commitPosition?.valid)
            c.commands.moveVideoTo(
              layout.item.id,
              commitPosition.start,
              commitPosition.trackId,
              false,
              requestedStart(),
              commitPosition.targetClipId,
            );
          c.commands.endHistoryTransaction();
          c.setDraggedClipId("");
          if (commitPosition?.valid) {
            const snap = snappedOverlayPoint('video', commitPosition.trackId, commitPosition.start, grabOffsetX, grabOffsetY);
            settleDraft(value, 'settling', snap.x, snap.y);
          } else {
            settleDraft(value, 'reverting', clipRect.left + grabOffsetX, clipRect.top + grabOffsetY);
          }
          return;
        }
        if (wasDragging) {
          // blur/cancel/unmount aborts the transaction rather than committing
          // a half-updated position, but it must still release all UI state.
          c.commands.endHistoryTransaction();
          c.setDraggedClipId("");
          const value = c.draft.getSnapshot();
          if (value && reason !== 'unmount') {
            settleDraft(value, 'reverting', clipRect.left + grabOffsetX, clipRect.top + grabOffsetY);
          } else {
            c.draft.set(null);
          }
          return;
        }
        if (c.timelineSeekFrameRef.current !== null)
          cancelAnimationFrame(c.timelineSeekFrameRef.current);
        c.timelineSeekFrameRef.current = null;
        // A short click still locates the playhead once on release. No
        // pointermove scrub occurs while the gesture is pending.
        if (reason === "pointerup") {
          const rect = c.timelineRef.current?.getBoundingClientRect();
          const nextTime = rect ? time(x, rect) : c.playheadRef.current;
          c.scrub(nextTime, true);
          if (resume) c.seek(nextTime, true);
        }
      };
      const onBlur = () => end(undefined, "blur");
      const cleanup = () => end(undefined, "unmount");
      activeGestureCleanup.current = cleanup;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
      window.addEventListener("pointercancel", end, { once: true });
      window.addEventListener("blur", onBlur);
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
              mode: edge === 'start' ? 'trim-start' : 'trim-end',
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
  const trimText = useEventCallback(
    (event: React.PointerEvent, item: MergeTextItem, edge: "start" | "end") => {
      const o = current.current;
      if (event.button !== 0 || !o.timelineRef.current || !o.totalDuration) return;
      event.preventDefault();
      event.stopPropagation();
      o.setSelectedClipId("");
      o.setSelectedAudioId("");
      o.setSelectedTextId(item.id);
      o.clearClipMenu();
      o.clearAudioMenu();
      o.clearTextMenu();
      const rect = o.timelineRef.current.getBoundingClientRect();
      const minDuration = Math.max(0.05, o.frameStep);
      const originalStart = Math.max(0, item.startTime);
      const originalEnd = originalStart + Math.max(minDuration, item.duration);
      let latestX = event.clientX;
      let frame: number | null = null;
      o.commands.beginHistoryTransaction();
      const values = (clientX: number) => {
        // End trimming may intentionally extend beyond the current timeline
        // end.  The regular seek helper clamps to totalDuration, which would
        // make a text clip already at the end impossible to lengthen.
        const pointerTime = edge === 'end'
          ? Math.max(0, (clientX - rect.left) / Math.max(0.0001, o.pixelsPerSecond))
          : time(clientX, rect);
        if (edge === "start") {
          const startTime = clamp(pointerTime, 0, originalEnd - minDuration);
          return { startTime, duration: Math.max(minDuration, originalEnd - startTime) };
        }
        const endTime = clamp(pointerTime, originalStart + minDuration, Math.max(o.totalDuration, originalStart + minDuration));
        return { startTime: originalStart, duration: Math.max(minDuration, endTime - originalStart) };
      };
      const move = (e: PointerEvent) => {
        latestX = e.clientX;
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          const value = values(latestX);
          current.current.draft.set({
            id: item.id,
            kind: "text",
            start: value.startTime,
            duration: value.duration,
            mode: edge === 'start' ? 'trim-start' : 'trim-end',
          });
        });
      };
      const end = (e: PointerEvent) => {
        latestX = e.clientX;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        const value = values(latestX);
        o.commands.updateText(item.id, { startTime: value.startTime, duration: value.duration }, false);
        o.commands.endHistoryTransaction();
        o.draft.set(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
      window.addEventListener("pointercancel", end, { once: true });
    },
  );
  const trimAudio = useEventCallback(
    (event: React.PointerEvent, layout: AudioClipLayout, edge: "start" | "end") => {
      const o = current.current;
      if (event.button !== 0 || !o.timelineRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      o.setSelectedClipId("");
      o.setSelectedTextId("");
      o.setSelectedAudioId(layout.item.id);
      o.clearClipMenu();
      o.clearAudioMenu();
      const rect = o.timelineRef.current.getBoundingClientRect();
      const secondsPerPixel = o.totalDuration
        ? o.totalDuration / Math.max(1, rect.width)
        : o.frameStep;
      const origin = event.clientX;
      const startTrim = Math.max(0, layout.item.trimStart);
      const source = Math.max(
        startTrim + o.frameStep,
        o.audioDurations?.[layout.item.id] ?? Math.max(layout.item.trimEnd, startTrim + layout.duration),
      );
      const endSource = layout.item.trimEnd > startTrim ? Math.min(layout.item.trimEnd, source) : source;
      let latest: PointerEvent | null = null;
      let frame: number | null = null;
      o.commands.beginHistoryTransaction();
      const values = (pointer: PointerEvent) => {
        const delta = (pointer.clientX - origin) * secondsPerPixel;
        if (edge === "start") {
          const trimStart = clamp(startTrim + delta, 0, endSource - o.frameStep);
          return {
            trimStart,
            startTime: Math.max(0, layout.start + trimStart - startTrim),
            duration: Math.max(o.frameStep, endSource - trimStart),
          };
        }
        const trimEnd = clamp(endSource + delta, startTrim + o.frameStep, source);
        return { trimEnd, startTime: layout.start, duration: Math.max(o.frameStep, trimEnd - startTrim) };
      };
      const move = (pointer: PointerEvent) => {
        latest = pointer;
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (!latest) return;
          const value = values(latest);
          o.draft.set({ id: layout.item.id, kind: "audio", start: value.startTime, duration: value.duration, mode: edge === "start" ? "trim-start" : "trim-end" });
        });
      };
      const end = (pointer: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        if (frame !== null) cancelAnimationFrame(frame);
        const value = values(pointer);
        const patch = edge === "start"
          ? { trimStart: value.trimStart, startTime: value.startTime }
          : { trimEnd: value.trimEnd };
        o.commands.updateAudio(layout.item.id, patch, false);
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
    activeGestureCleanup.current?.();
    const id = layout.item.id;
    const label = kind === 'text'
      ? ((layout.item as { text?: string }).text ?? id)
      : ((layout.item as { name?: string }).name ?? id)
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
    let phase: TimelineGesturePhase = transitionTimelineGesture("idle", "pointerdown"),
      x = event.clientX,
      y = event.clientY;
    const pointerId = event.pointerId;
    const captureTarget = event.currentTarget as HTMLElement;
    const clipRect = captureTarget.getBoundingClientRect();
    const grabOffsetX = event.clientX - clipRect.left;
    const grabOffsetY = event.clientY - clipRect.top;
    try { captureTarget.setPointerCapture(pointerId); } catch { /* capture can fail after unmount */ }
    const releaseCapture = () => {
      try {
        if (captureTarget.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId);
      } catch { /* pointer already released */ }
    };
    const timer = setTimeout(
      () => {
        if (phase !== "pending") return;
        phase = transitionTimelineGesture(phase, "longpress");
        const c = current.current;
        c.commands.beginHistoryTransaction();
        if (kind === "audio") c.setDraggedAudioId(id);
        else c.setDraggedTextId(id);
        const initial = nextPosition();
        if (initial) c.draft.set({
          id,
          kind,
          label,
          duration: layout.duration,
          height: clipRect.height,
          pointerX: x,
          pointerY: y,
          grabOffsetX,
          grabOffsetY,
          phase: "dragging",
          ...initial,
        });
      },
      kind === "audio" ? 320 : 260,
    );
    type DragPosition = {
      start: number;
      trackId: string;
      targetClipId: string | null;
      valid: boolean;
    };
    let lastValidPosition: DragPosition | null = null;
    const nextPosition = () => {
      const c = current.current,
        rect = c.timelineRef.current?.getBoundingClientRect();
      if (!rect) return;
      const targetTrack = trackAt(x, y, kind);
      const track = targetTrack ?? layout.trackId;
      const hitClip = clipAt(x, y, kind);
      const targetClipId = hitClip === id ? null : hitClip;
      const requested = time(x, rect) - offset;
      const start = kind === "text"
        ? clamp(requested, 0, c.totalDuration)
        : resolveTimelineDragCommit(
            requested,
            layout.duration,
            id,
            track,
            c.audioLayouts,
            c.audioTrackCount > 1,
          );
      const position = { start, trackId: track, targetClipId, valid: Boolean(targetTrack) };
      if (position.valid) lastValidPosition = position;
      return position;
    };
    const move = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (phase !== "dragging") {
        if (phase === "pending") phase = transitionTimelineGesture(phase, "move");
        return;
      }
      if (o.animationFrameRef.current !== null)
        cancelAnimationFrame(o.animationFrameRef.current);
      o.animationFrameRef.current = requestAnimationFrame(() => {
        o.animationFrameRef.current = null;
        const position = nextPosition();
        if (position) current.current.draft.set({
          id,
          kind,
          label,
          duration: layout.duration,
          height: clipRect.height,
          pointerX: x,
          pointerY: y,
          grabOffsetX,
          grabOffsetY,
          phase: 'dragging',
          ...position,
        });
      });
    };
    let finished = false;
    const end = (e?: PointerEvent, reason: TimelineGestureEvent = "pointerup") => {
      if (finished) return;
      finished = true;
      if (e) {
        x = e.clientX;
        y = e.clientY;
      }
      const wasDragging = phase === "dragging";
      phase = transitionTimelineGesture(phase, reason);
      clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", onBlur);
      releaseCapture();
      const c = current.current;
      if (c.animationFrameRef.current !== null)
        cancelAnimationFrame(c.animationFrameRef.current);
      c.animationFrameRef.current = null;
      if (wasDragging && reason === "pointerup") {
        const position = nextPosition();
        // Preserve the last confirmed row/clip when pointer capture causes a
        // one-frame miss at release.  Without this fallback a same-line drop
        // can finish as a no-op even though the preview reached its target.
        const commitPosition = position?.valid ? position : lastValidPosition;
        const value = c.draft.getSnapshot() ?? {
          id,
          kind,
          label,
          duration: layout.duration,
          height: clipRect.height,
          pointerX: x,
          pointerY: y,
          grabOffsetX,
          grabOffsetY,
          start: layout.start,
          trackId: layout.trackId,
        };
        if (commitPosition?.valid) {
          if (kind === "audio")
            c.commands.moveAudioTo(
              id,
              commitPosition.start,
              commitPosition.trackId,
              false,
              (() => {
                const rect = c.timelineRef.current?.getBoundingClientRect();
                return rect ? time(x, rect) - offset : commitPosition.start;
              })(),
              commitPosition.targetClipId,
            );
          else
            c.commands.updateText(
              id,
              { startTime: commitPosition.start, trackId: commitPosition.trackId },
              false,
            );
        }
        c.commands.endHistoryTransaction();
        if (commitPosition?.valid) {
          const snap = snappedOverlayPoint(kind, commitPosition.trackId, commitPosition.start, grabOffsetX, grabOffsetY);
          settleDraft(value, 'settling', snap.x, snap.y);
        } else {
          settleDraft(value, 'reverting', clipRect.left + grabOffsetX, clipRect.top + grabOffsetY);
        }
      } else if (wasDragging) {
        c.commands.endHistoryTransaction();
        const value = c.draft.getSnapshot();
        if (value && reason !== 'unmount') {
          settleDraft(value, 'reverting', clipRect.left + grabOffsetX, clipRect.top + grabOffsetY);
        } else {
          c.draft.set(null);
        }
      }
      if (kind === "audio") c.setDraggedAudioId("");
      else c.setDraggedTextId("");
    };
    const onBlur = () => end(undefined, "blur");
    const cleanup = () => end(undefined, "unmount");
    activeGestureCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
    window.addEventListener("blur", onBlur);
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
    handleAudioTrimPointerDown: trimAudio,
    handleTextTrimPointerDown: trimText,
    handleAudioPointerDown: audio,
    handleTextPointerDown: text,
  };
}
