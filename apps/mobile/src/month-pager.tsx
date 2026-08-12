/**
 * Paging a month grid sideways, and the month vocabulary that goes with it.
 *
 * > **Extracted 2026-08-12, when the date picker was asked to swipe like the calendar does.**
 * > The mechanics below cost a whole session to get right on 2026-08-06 - three wrong answers,
 * > four root causes, and a red screen on the founder's phone - and writing them a second time
 * > in `DateField` would have been the most expensive copy-paste available in this codebase.
 * > What each caller keeps is its own chrome and its own cells; what they share is the gesture.
 *
 * ### Why this is a ScrollView and not a PanResponder
 *
 * The hard part of the gesture is not the translation, it is the **arbitration**: a horizontal
 * drag belongs to the pager, a vertical drag to the page or sheet behind it, and a tap to
 * whichever day is under it. A horizontal `ScrollView` with `pagingEnabled` resolves all three on
 * both platforms and brings the snap physics with it. The hand-rolled version moved 22 pixels -
 * exactly one drag step - and froze.
 *
 * ### The shape
 *
 * Three months are rendered in a row `3 * width` wide, resting at `-width` so the middle one is
 * on screen. On release it settles to a neighbour, the cursor moves, and the offset snaps back to
 * the middle - by which point the three grids have re-rendered around the new month, so the snap
 * is invisible.
 *
 * The caller draws the heading from {@link MonthPager.shown} rather than from its own cursor,
 * which is what keeps the month name moving WITH the grid instead of half a second behind it.
 */

import { useEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent, ScrollView as ScrollViewType } from 'react-native';

/** A year and a 1-based month. The 1-based part is load-bearing: `Date` is 0-based and this is not. */
export type MonthCursor = { year: number; month: number };

/** Single-letter column headings, Sunday first. One definition; it was previously two. */
export const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

/** Six weeks, fixed, so a grid's height never changes as months are paged. */
export const MONTH_CELLS = 42;

export function todayParts(): MonthCursor {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/**
 * The month `delta` away, carrying the year.
 *
 * Its own function because the pager needs the two NEIGHBOURS as well as the destination: a swipe
 * draws the month either side of the current one before it knows which way you are going.
 *
 * The double modulo is what makes December + 1 and January - 1 both work: `%` keeps the sign of
 * the dividend in JavaScript, so a plain one gives -1 for January's predecessor.
 */
export function shiftMonth(from: MonthCursor, delta: number): MonthCursor {
  const zeroBased = from.month - 1 + delta;
  return {
    year: from.year + Math.floor(zeroBased / 12),
    month: (((zeroBased % 12) + 12) % 12) + 1,
  };
}

/** The six-week span a month grid draws, as dates built from components rather than parsed. */
export function monthCells(year: number, month: number): Date[] {
  // Built from components, never from a parsed ISO string: an ISO date is UTC midnight and
  // renders a day early in a negative-offset timezone.
  const first = new Date(year, month - 1, 1);
  const leading = first.getDay();
  const start = new Date(year, month - 1, 1 - leading);
  return Array.from({ length: MONTH_CELLS }, (_, i) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
}

export type MonthPager = {
  /** The measured page width. Null before first layout, when nothing should be drawn. */
  width: number | null;
  /** Goes on the view WRAPPING the scroll view, which is what defines a page's width. */
  onLayout: (event: LayoutChangeEvent) => void;
  pagerRef: React.RefObject<ScrollViewType | null>;
  /** Spread onto the horizontal `ScrollView`. */
  pagerProps: {
    horizontal: true;
    pagingEnabled: true;
    showsHorizontalScrollIndicator: false;
    scrollEventThrottle: number;
    decelerationRate: 'fast';
    onScroll: (event: { nativeEvent: { contentOffset: { x: number } } }) => void;
    onMomentumScrollEnd: (event: { nativeEvent: { contentOffset: { x: number } } }) => void;
    onScrollEndDrag: (event: { nativeEvent: { contentOffset: { x: number } } }) => void;
  };
  /** The three months to render, previous / current / next. */
  months: [MonthCursor, MonthCursor, MonthCursor];
  /**
   * The month the heading should name: the one under the finger mid-swipe, and `cursor` at rest.
   *
   * **Read this rather than the cursor.** Committing is deliberately late - it waits for the
   * scroll to come to rest - so a heading driven by the cursor sits on the old month for the
   * whole animation and then snaps, about half a second behind the thing it names.
   */
  shown: MonthCursor;
};

/**
 * The swipe, as a hook, so a caller keeps its own chrome and cells.
 *
 * @param cursor the month currently committed
 * @param onStep called with -1 or +1 when a page settles on a neighbour
 */
export function useMonthPager(cursor: MonthCursor, onStep: (delta: number) => void): MonthPager {
  const [width, setWidth] = useState<number | null>(null);
  const pagerRef = useRef<ScrollViewType | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True from the moment a page is committed until the recentre it causes has been absorbed. */
  const committing = useRef(false);
  /** The most recent offset, so a settle acts on where the pager IS, not where it was. */
  const lastX = useRef(0);
  /** Which page the finger is over, as a delta from `cursor`. Only the heading reads this. */
  const [preview, setPreview] = useState(0);

  /** Put the viewport back on the middle page, where a swipe can go either way. */
  const recentre = (animated: boolean) => {
    if (width !== null) pagerRef.current?.scrollTo({ x: width, y: 0, animated });
  };

  // Once the width is known, and again whenever it changes, rest on the middle page. Without
  // this the pager opens showing the PREVIOUS month, which is page zero.
  useEffect(() => {
    if (width === null) return;
    // After layout rather than during it: scrolling a view that has not been laid out is a no-op
    // on Android, and the pager would silently open on the wrong page there alone.
    const id = setTimeout(() => recentre(false), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  // Recentre after the cursor moves for any reason - an arrow, or a jump - so the pages either
  // side of the new month are the ones a swipe reaches.
  useEffect(() => {
    recentre(false);
    // An arrow or a jump moves the cursor with no scroll behind it, so the preview has nothing
    // to reset it and would keep naming a month offset from the new one.
    setPreview(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor.year, cursor.month]);

  useEffect(() => () => (settle.current ? clearTimeout(settle.current) : undefined), []);

  /**
   * Act on where the pager came to rest.
   *
   * Reads `lastX` rather than an offset captured when the timer was scheduled. The captured
   * version acts on an offset up to 140ms old, which is most of a snap animation - it is only
   * ever right when the scroll happens to have already stopped.
   */
  const commitPage = () => {
    if (width === null || committing.current) return;
    const x = lastX.current;
    const page = Math.round(x / width);
    const delta = page - 1;
    // Ignore anything that has not landed on a neighbouring page: a drag that fell short snaps
    // back on its own and must not be read as a month.
    if (delta === 0 || Math.abs(x - page * width) > width * 0.1) return;
    committing.current = true;
    // Batched with the cursor move, so the title never flashes: it is already showing this month
    // from the preview, and `cursor + delta` with the preview back at zero is the same month.
    setPreview(0);
    onStep(delta);
    // Recentred here as well as by the `cursor` effect, because this is the path that must not
    // be left mid-page for even a frame; the effect is what covers an arrow or a jump.
    recentre(false);
    setTimeout(() => (committing.current = false), 200);
  };

  const onScroll = (x: number) => {
    if (width === null) return;
    /*
     * Deaf while committing.
     *
     * Committing recentres, recentring scrolls, and scrolling lands back here - so without this
     * one swipe can page twice, the second time from an offset the first has already acted on.
     */
    if (committing.current) return;
    lastX.current = x;

    // The title, live. `round` puts the boundary at half a page, so this is at most two state
    // changes across a whole swipe rather than one per frame.
    const over = Math.round(x / width) - 1;
    if (over !== preview) setPreview(over);

    /*
     * A quiet period, as the backstop.
     *
     * The scroll-end events are the real signal and this covers what they miss: a slow drag
     * released without a flick produces no momentum event on some platforms, and on web the
     * paging is CSS scroll-snap, whose animation neither event describes. Waiting for the offset
     * to stop moving is true everywhere, because it is a statement about the offset rather than
     * about how it got there.
     */
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(commitPage, 140);
  };

  return {
    width,
    onLayout: (event) => setWidth(event.nativeEvent.layout.width),
    pagerRef,
    pagerProps: {
      horizontal: true,
      pagingEnabled: true,
      showsHorizontalScrollIndicator: false,
      scrollEventThrottle: 16,
      // Turned off so a fast flick cannot cross two months in one gesture - there is no third
      // page to land on, and the pager would snap back looking broken.
      decelerationRate: 'fast',
      onScroll: (event) => onScroll(event.nativeEvent.contentOffset.x),
      /*
        The authoritative signals on a device, both handled because only one of them fires for
        any given gesture: a flick ends with momentum, a slow drag released in place ends
        without it. Each carries the settled offset, so neither waits on the backstop.
      */
      onMomentumScrollEnd: (event) => {
        lastX.current = event.nativeEvent.contentOffset.x;
        commitPage();
      },
      onScrollEndDrag: (event) => {
        lastX.current = event.nativeEvent.contentOffset.x;
      },
    },
    months: [shiftMonth(cursor, -1), cursor, shiftMonth(cursor, 1)],
    shown: preview === 0 ? cursor : shiftMonth(cursor, preview),
  };
}
