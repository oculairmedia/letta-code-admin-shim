/**
 * lcp-2oxb.1 — Lightweight performance instrumentation for the admin-shim.
 *
 * Three concerns are handled here:
 *
 *   1. Event-loop delay histogram (perf_hooks.monitorEventLoopDelay).
 *      The monitor is enabled at first import. `getEventLoopDelayStats()`
 *      returns { p50_ms, p95_ms, max_ms } converted from nanoseconds, then
 *      resets the histogram so each call reports "since last read".
 *
 *   2. Frame-append counters. `recordFrameAppend(bytes)` is called by
 *      runs.ts:appendRunFrame after a successful disk write. Stats are
 *      cumulative since process start (never reset).
 *
 *   3. RSS snapshot. `getRssBytes()` is a thin wrapper over
 *      process.memoryUsage.rss() that avoids allocating a full memoryUsage
 *      object on the hot-path.
 *
 * THREAD SAFETY: Node.js is single-threaded; no locking needed.
 * SIDE EFFECT ON IMPORT: the event-loop delay monitor starts immediately.
 *   Import early (e.g. from server.ts top-level) for the broadest measurement
 *   window; importing later is fine but will miss early-startup jitter.
 *
 * @module perf-metrics
 * @bead lcp-2oxb.1
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

// ── 1. Event-loop delay monitor ──────────────────────────────────────────────

/** Resolution in ms for the ELD sampler (lower = more precise, higher CPU). */
const ELD_RESOLUTION_MS = 20;

const _eldHistogram: IntervalHistogram = monitorEventLoopDelay({
  resolution: ELD_RESOLUTION_MS,
});
_eldHistogram.enable();

/**
 * Snapshot of event-loop delay percentiles since the last call (or since
 * process start on the very first call). Values are in milliseconds.
 * Resets the histogram after reading so each call is a "since-last-read" window.
 */
export interface EventLoopDelayStats {
  /** 50th-percentile delay in ms. */
  p50_ms: number;
  /** 95th-percentile delay in ms. */
  p95_ms: number;
  /** Maximum observed delay in ms. */
  max_ms: number;
}

/**
 * Read the event-loop delay histogram, convert ns → ms, reset for next call.
 *
 * @returns EventLoopDelayStats for the window since the last call.
 */
export function getEventLoopDelayStats(): EventLoopDelayStats {
  const p50_ms = _eldHistogram.percentile(50) / 1e6;
  const p95_ms = _eldHistogram.percentile(95) / 1e6;
  const max_ms = _eldHistogram.max / 1e6;
  _eldHistogram.reset();
  return { p50_ms, p95_ms, max_ms };
}

// ── 2. Frame-append counters ─────────────────────────────────────────────────

/** Cumulative frame-append stats since process start. */
export interface FrameAppendStats {
  /** Total number of frames written to frames.jsonl across all runs. */
  frames_appended: number;
  /** Total bytes written (length of each JSON line including trailing \n). */
  bytes_appended: number;
}

let _framesAppended = 0;
let _bytesAppended = 0;

/**
 * Increment the frame-append counters. Called by runs.ts:appendRunFrame
 * immediately after a successful appendFileSync.
 *
 * @param bytes - Byte length of the JSON line just written (including "\n").
 */
export function recordFrameAppend(bytes: number): void {
  _framesAppended += 1;
  _bytesAppended += bytes;
}

/**
 * Return cumulative frame-append statistics since process start.
 * The counters are never reset; this is always a since-start view.
 */
export function getFrameAppendStats(): FrameAppendStats {
  return {
    frames_appended: _framesAppended,
    bytes_appended: _bytesAppended,
  };
}

// ── 3. RSS snapshot ──────────────────────────────────────────────────────────

/**
 * Resident set size of the current process in bytes.
 * Uses the allocation-free `process.memoryUsage.rss()` fast path.
 */
export function getRssBytes(): number {
  return process.memoryUsage.rss();
}
