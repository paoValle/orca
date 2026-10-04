import { forceRepaintThroughRenderPause } from './terminal-render-pause-release'
import {
  disposeParsedDirtyRows,
  readParsedDirtyRowSpan,
  resetParsedDirtyRows,
  type ParsedDirtyRowSpan
} from './terminal-parsed-dirty-rows'
import { runGuardedWriteCompletionStep } from './xterm-write-callback-guard'

export type ForegroundTerminalOutputTarget = {
  buffer?: {
    active?: {
      type?: string
      cursorY?: number
      baseY?: number
      viewportY?: number
    }
  }
  rows?: number
  _core?: {
    refresh?(start: number, end: number, sync?: boolean): void
  }
  refresh?(start: number, end: number): void
  write(data: string, callback?: () => void): void
}

type ForegroundTerminalWriteOptions = {
  forceViewportRefresh?: boolean
  followupViewportRefresh?: boolean
  shouldRefreshViewportSynchronously?: () => boolean
  shouldReleaseRenderPause?: () => boolean
  onParsed?: () => void
  onWriteFailure?: () => void
}

type PendingViewportSettleRefresh =
  | { kind: 'raf'; id: number }
  | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }

type PendingViewportSettleRepair = {
  /** The span the immediate repair used, or `null` when it stayed whole-grid. */
  span: ParsedDirtyRowSpan | null
  /** Geometry that span addressed, re-checked when the queued frame runs. */
  viewport: ViewportSnapshot
  /** The repair path the write used; a change means the renderer was swapped. */
  synchronous: boolean
}

const pendingViewportSettleRefreshByTerminal = new WeakMap<
  ForegroundTerminalOutputTarget,
  { pending: PendingViewportSettleRefresh; repair: PendingViewportSettleRepair }
>()

type ViewportSnapshot = {
  type: string | null
  cursorY: number | null
  baseY: number | null
  viewportY: number | null
  rows: number | null
}

function refreshVisibleRows(
  terminal: ForegroundTerminalOutputTarget,
  synchronously: boolean,
  shouldReleaseRenderPause?: () => boolean,
  span?: ParsedDirtyRowSpan | null
): void {
  if (typeof terminal.rows !== 'number' || terminal.rows < 1) {
    return
  }

  try {
    // Why: only reveal-owned replay may override xterm's paused observer state;
    // ordinary or newly-hidden output must leave background rendering paused.
    if (shouldReleaseRenderPause?.() === true && forceRepaintThroughRenderPause(terminal)) {
      return
    }
    const lastRow = Math.max(0, terminal.rows - 1)
    // Why not always the whole grid: xterm's render debouncer unions ranges, so a
    // 0..rows-1 repair request turns every frame into a full-viewport cell walk.
    // `span` is the parse's own dirty rows; `null` keeps the whole-grid repaint.
    const start = span ? Math.min(Math.max(span.start, 0), lastRow) : 0
    const end = span ? Math.min(Math.max(span.end, start), lastRow) : lastRow
    // Why: DOM-rendered Windows ConPTY rewrites need an immediate repair, while
    // WebGL can merge this request into xterm's already-queued frame.
    if (synchronously && typeof terminal._core?.refresh === 'function') {
      terminal._core.refresh(start, end, true)
      return
    }
    if (typeof terminal.refresh === 'function') {
      terminal.refresh(start, end)
      return
    }
    terminal._core?.refresh?.(start, end, false)
  } catch {
    // Ignore disposed terminals; PTY output can race pane teardown.
  }
}

function captureViewportSnapshot(terminal: ForegroundTerminalOutputTarget): ViewportSnapshot {
  const active = terminal.buffer?.active
  return {
    type: typeof active?.type === 'string' ? active.type : null,
    cursorY: typeof active?.cursorY === 'number' ? active.cursorY : null,
    baseY: typeof active?.baseY === 'number' ? active.baseY : null,
    viewportY: typeof active?.viewportY === 'number' ? active.viewportY : null,
    rows: typeof terminal.rows === 'number' ? terminal.rows : null
  }
}

function viewportChangedDuringWrite(
  beforeWrite: ViewportSnapshot,
  afterWrite: ViewportSnapshot
): boolean {
  return (
    afterWrite.baseY !== null &&
    afterWrite.viewportY !== null &&
    (afterWrite.baseY !== beforeWrite.baseY || afterWrite.viewportY !== beforeWrite.viewportY)
  )
}

/**
 * The rows this write's repair must cover: the parse's own dirty span widened by
 * the cursor rows on both sides of the write.
 *
 * Why the cursor rows: xterm's WebGL model drops its cursor whenever an update
 * pass excludes the cursor row, so a repair that skips it would blank the caret.
 * Returns `null` — repaint everything — whenever the span is unknown, the
 * viewport scrolled (dirty rows were recorded against the pre-scroll origin), or
 * the write flipped between the normal and alternate buffer.
 */
function repairRowSpan(
  terminal: ForegroundTerminalOutputTarget,
  beforeWrite: ViewportSnapshot,
  afterWrite: ViewportSnapshot
): ParsedDirtyRowSpan | null {
  if (beforeWrite.type !== afterWrite.type || viewportChangedDuringWrite(beforeWrite, afterWrite)) {
    return null
  }
  const parsed = readParsedDirtyRowSpan(terminal)
  if (!parsed) {
    return null
  }
  let { start, end } = parsed
  for (const cursorY of [beforeWrite.cursorY, afterWrite.cursorY]) {
    if (cursorY === null) {
      return null
    }
    start = Math.min(start, cursorY)
    end = Math.max(end, cursorY)
  }
  return { start, end }
}

/** Widest span the inputs cover; `null` on either side means "nothing known". */
function unionRowSpans(
  left: ParsedDirtyRowSpan | null,
  right: ParsedDirtyRowSpan | null
): ParsedDirtyRowSpan | null {
  if (!left) {
    return right
  }
  if (!right) {
    return left
  }
  return { start: Math.min(left.start, right.start), end: Math.max(left.end, right.end) }
}

/**
 * Widen a repair that is already queued so the reset about to happen cannot drop
 * rows it still owes. A pending whole-grid repair (`span: null`) already covers
 * them, and one renderer swap invalidates them wholesale.
 */
function carryRowsIntoPendingRepair(
  terminal: ForegroundTerminalOutputTarget,
  carried: ParsedDirtyRowSpan | null
): void {
  const queued = pendingViewportSettleRefreshByTerminal.get(terminal)
  if (!carried || !queued?.repair.span) {
    return
  }
  // Why mutate in place: the queued frame already closed over this repair record,
  // so replacing the map entry would leave that frame on the old span.
  queued.repair.span = unionRowSpans(queued.repair.span, carried)
}

/**
 * The rows the queued repeat must repaint, or `null` for the whole viewport.
 *
 * Why the repeat is not simply re-issued as the immediate span: the delay crosses
 * a frame, so other output can arrive first. The rows parsed since the write and
 * the caret now are unioned in, and any geometry the span cannot be proven to
 * still address — a scroll, a resize, a buffer flip, an unobservable parse, or a
 * terminal xterm itself asked to repaint whole — falls back to the whole grid.
 */
function pendingRepairRowSpan(
  terminal: ForegroundTerminalOutputTarget,
  repair: PendingViewportSettleRepair
): ParsedDirtyRowSpan | null {
  const scheduled = repair.viewport
  const current = captureViewportSnapshot(terminal)
  if (
    repair.span === null ||
    scheduled.type === null ||
    scheduled.type !== current.type ||
    scheduled.rows === null ||
    scheduled.rows !== current.rows ||
    scheduled.baseY === null ||
    scheduled.baseY !== current.baseY ||
    scheduled.viewportY === null ||
    scheduled.viewportY !== current.viewportY
  ) {
    return null
  }
  const parsedSince = readParsedDirtyRowSpan(terminal)
  if (!parsedSince || current.cursorY === null) {
    return null
  }
  return {
    start: Math.min(repair.span.start, parsedSince.start, current.cursorY),
    end: Math.max(repair.span.end, parsedSince.end, current.cursorY)
  }
}

function cancelScheduledViewportSettleRefresh(terminal: ForegroundTerminalOutputTarget): void {
  const queued = pendingViewportSettleRefreshByTerminal.get(terminal)
  if (!queued) {
    return
  }
  pendingViewportSettleRefreshByTerminal.delete(terminal)
  if (queued.pending.kind === 'raf') {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(queued.pending.id)
    }
    return
  }
  clearTimeout(queued.pending.id)
}

function scheduleViewportSettleRefresh(
  terminal: ForegroundTerminalOutputTarget,
  repair: PendingViewportSettleRepair,
  shouldRefreshSynchronously?: () => boolean,
  shouldReleaseRenderPause?: () => boolean
): void {
  cancelScheduledViewportSettleRefresh(terminal)
  const runRepair = (): void => {
    pendingViewportSettleRefreshByTerminal.delete(terminal)
    const synchronous = shouldRefreshSynchronously?.() ?? true
    // Why the path check: the resolver reads the attached renderer, so a flipped
    // path means a renderer was swapped mid-frame and only the whole viewport can
    // be proven converged for the replacement.
    refreshVisibleRows(
      terminal,
      synchronous,
      shouldReleaseRenderPause,
      synchronous === repair.synchronous ? pendingRepairRowSpan(terminal, repair) : null
    )
  }
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(runRepair)
    pendingViewportSettleRefreshByTerminal.set(terminal, {
      pending: { kind: 'raf', id },
      repair
    })
    return
  }

  const id = setTimeout(runRepair, 16)
  pendingViewportSettleRefreshByTerminal.set(terminal, { pending: { kind: 'timeout', id }, repair })
}

function settleForegroundRender(
  terminal: ForegroundTerminalOutputTarget,
  beforeWriteViewport: ViewportSnapshot,
  options: ForegroundTerminalWriteOptions,
  carriedDirtySpan: ParsedDirtyRowSpan | null
): void {
  const afterWriteViewport = captureViewportSnapshot(terminal)
  const synchronous = options.shouldRefreshViewportSynchronously?.() ?? true
  const span = repairRowSpan(terminal, beforeWriteViewport, afterWriteViewport)
  refreshVisibleRows(terminal, synchronous, options.shouldReleaseRenderPause, span)
  // Why: when output advances the viewport, Chromium can paint the freshly
  // scrolled top row one frame later than xterm finishes parsing. Repaint once
  // more after the scroll settles so the user doesn't need to jiggle the window.
  if (
    options.followupViewportRefresh ||
    viewportChangedDuringWrite(beforeWriteViewport, afterWriteViewport)
  ) {
    scheduleViewportSettleRefresh(
      terminal,
      {
        // Why the carry and the guard: the queued repeat must also cover rows a
        // reset dropped, but only when this write's own span is proven — `null`
        // requires the whole grid, which covers the carried rows anyway.
        span: span ? unionRowSpans(span, carriedDirtySpan) : null,
        viewport: afterWriteViewport,
        synchronous
      },
      options.shouldRefreshViewportSynchronously,
      options.shouldReleaseRenderPause
    )
  }
}

export function writeForegroundTerminalChunk(
  terminal: ForegroundTerminalOutputTarget,
  data: string,
  options: ForegroundTerminalWriteOptions = {}
): boolean {
  const beforeWriteViewport = options.forceViewportRefresh
    ? captureViewportSnapshot(terminal)
    : null
  let carriedDirtySpan: ParsedDirtyRowSpan | null = null
  if (beforeWriteViewport) {
    // Why before the reset: a queued repair may still be waiting on rows an
    // earlier ordinary write dirtied, and this reset is about to forget them.
    carriedDirtySpan = readParsedDirtyRowSpan(terminal)
    carryRowsIntoPendingRepair(terminal, carriedDirtySpan)
    // Why here and not in the callback: the span must cover only this write's
    // parse, and xterm fires its dirty-row request between the two.
    resetParsedDirtyRows(terminal)
  }
  // Why guarded steps: this callback runs inside xterm's WriteBuffer loop,
  // where an escaping throw permanently wedges the terminal (see
  // xterm-write-callback-guard.ts). Guard settle and onParsed separately so a
  // renderer/WebGL failure during settle can't starve the replay-guard release.
  const runParsedSteps = (): void => {
    if (beforeWriteViewport) {
      runGuardedWriteCompletionStep('foreground-render-settle', () =>
        settleForegroundRender(terminal, beforeWriteViewport, options, carriedDirtySpan)
      )
    }
    if (options.onParsed) {
      runGuardedWriteCompletionStep('foreground-on-parsed', options.onParsed)
    }
  }
  try {
    terminal.write(data, runParsedSteps)
    return true
  } catch {
    // Why separate from parse completion: cleanup/recovery must run, but a
    // synchronous write failure is not parser liveness evidence.
    if (options.onWriteFailure) {
      runGuardedWriteCompletionStep('foreground-on-write-failure', options.onWriteFailure)
    }
    return false
  }
}

export function discardForegroundRenderSettle(terminal: ForegroundTerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal)
  disposeParsedDirtyRows(terminal)
}
