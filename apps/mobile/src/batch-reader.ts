/**
 * Turn many "read this one thing" calls into as few requests as their timing allows.
 *
 * ## The problem it solves
 *
 * A chat card reads its own poll so its tally is current, which is right: a count that only
 * moved when YOU voted would be wrong the second somebody else did. What was wrong is that
 * each card was also its own request. `screens/polls.tsx` said as much in a comment - "one
 * small authorized read per visible poll card, and a conversation rarely has more than one" -
 * and the dev trace found a conversation holding twenty-six. Opening that club chat cost 78
 * requests and 49 CORS preflights inside one second, and 36 of those were cards reading
 * themselves.
 *
 * ## Two windows, because cards do not arrive together
 *
 * The first version gathered for a flat 10ms and helped a great deal less than it should have:
 * the trace showed the same club chat issuing ten batch requests of one to seven ids instead of
 * one of twenty-six. Cards do not mount in a single tick - a long list commits its rows in
 * passes, spread over most of a second - so a window narrow enough to be invisible is also too
 * narrow to catch them.
 *
 * So the window depends on whether anything has been asked recently:
 *
 *  - **Quiet: flush fast.** The first card to ask after a pause gets its answer on the way
 *    almost immediately, so a screen opening does not sit on its fallback waiting for a timer.
 *  - **Busy: gather.** Once a flush has just happened, more cards are almost certainly still
 *    mounting, and waiting for them costs nothing anybody can see - the cards that are waiting
 *    are ones that had not asked yet.
 *
 * ## It remembers an answer briefly, and forgets it on any write
 *
 * The first version deliberately did not cache at all, on the grounds that a time-based cache
 * would answer `load.reload()` after a vote with the tally from before it. That reasoning was
 * right about the danger and wrong about the conclusion: the measurement showed event cards -
 * which do not re-read on anything - being read six times each, because scrolling destroys a row
 * and rebuilds it. No amount of batching helps a read that happens a second later.
 *
 * So an answer is reused for `FRESH_FOR_MS`, and **every write clears the whole map**. That keeps
 * the case the original reasoning protected: your own vote is never answered from memory, because
 * casting it emptied the memory. What is traded is that somebody ELSE's change can be up to that
 * window old, which is the same thing `useRefreshOnReturn` already trades and far less than the
 * app traded before by only updating when an unrelated message happened to arrive.
 *
 * **It does not reorder or filter.** A caller asks for one id and gets that id's answer or the
 * same failure it would have had on its own.
 *
 * ## The one behaviour that does change
 *
 * A failure now lands on every id in the same batch rather than on one. That is the same trade
 * `GET /sync` makes for channels, and it degrades the same way: a card whose read fails falls
 * back to the message's own sentence, so the screen is still readable. Worth stating plainly
 * because it is the only thing here a reader could be surprised by.
 */

/** The first ask after a pause. Short enough that a screen opening does not wait on a timer. */
const IDLE_WINDOW_MS = 12;

/** Asks that follow one closely. Long enough to cover a list committing its rows in passes. */
const BUSY_WINDOW_MS = 150;

/** How long after a flush the next ask still counts as part of the same arrival. */
const BUSY_FOR_MS = 600;

/**
 * How long an answer is reused before it is read again.
 *
 * > **This exists because scrolling remounts cards, not because reads are expensive.** A chat's
 * > `FlatList` unmounts rows that leave the screen and mounts them again on the way back, and a
 * > card reads on mount - so scrolling up and down a conversation re-read the same twelve event
 * > cards six times each and the same twenty-six polls ten times each, measured 2026-08-18. None
 * > of those reads could return anything new; the row had simply been destroyed and rebuilt.
 *
 * Short on purpose, and it is the number that decides how stale a tally may be. Any WRITE clears
 * this entirely (see `invalidate`), so your own vote is never answered from it - which is the one
 * case where a cache would be visibly wrong rather than merely old.
 */
const FRESH_FOR_MS = 15_000;

export type BatchReaderOptions<T> = {
  /** Read many, in one request. May be called more than once if the ids exceed `maxPerRequest`. */
  fetchMany: (ids: string[]) => Promise<T[]>;
  /** How to tell which returned item answers which requested id. */
  keyOf: (item: T) => string;
  /**
   * What to reject with when an id is absent from the answer.
   *
   * Injected rather than imported so this module does not depend on the API client that will
   * depend on it. The route omits an id the caller may not read AND one that no longer exists,
   * which is deliberate - so the error handed back has to be the same "not found" a caller
   * already handles.
   */
  missing: (id: string) => Error;
  /** The route's own ceiling. Asking for more in one request is a 400. */
  maxPerRequest: number;
  idleWindowMs?: number;
  busyWindowMs?: number;
  freshForMs?: number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export type BatchReader<T> = ((id: string) => Promise<T>) & { invalidate: () => void };

export function createBatchReader<T>(opts: BatchReaderOptions<T>): BatchReader<T> {
  const idleWindow = opts.idleWindowMs ?? IDLE_WINDOW_MS;
  const busyWindow = opts.busyWindowMs ?? BUSY_WINDOW_MS;
  const freshFor = opts.freshForMs ?? FRESH_FOR_MS;

  /** Asked for, not yet sent. One deferred per id, however many callers want it. */
  const waiting = new Map<string, Deferred<T>>();
  /** Currently on the wire. A caller arriving now joins the request rather than starting one. */
  const inFlight = new Map<string, Promise<T>>();
  /** Recently answered, so a row rebuilt by scrolling does not ask again. */
  const fresh = new Map<string, { item: T; at: number }>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;

  const flush = async () => {
    timer = null;
    lastFlushAt = Date.now();

    // Taken and cleared FIRST, so anything asked for while the request is in flight starts the
    // next batch rather than joining one already on the wire and never being answered.
    const batch = new Map(waiting);
    waiting.clear();
    for (const [id, entry] of batch) inFlight.set(id, entry.promise);

    const ids = [...batch.keys()];
    for (let start = 0; start < ids.length; start += opts.maxPerRequest) {
      const chunk = ids.slice(start, start + opts.maxPerRequest);
      try {
        const items = await opts.fetchMany(chunk);
        const byId = new Map(items.map((item) => [opts.keyOf(item), item]));

        for (const id of chunk) {
          const entry = batch.get(id)!;
          const item = byId.get(id);
          if (item === undefined) {
            // Absent means gone or not ours. Never remembered: a card whose poll was deleted
            // must be able to find it again if it comes back.
            fresh.delete(id);
            entry.reject(opts.missing(id));
          } else {
            fresh.set(id, { item, at: Date.now() });
            entry.resolve(item);
          }
        }
      } catch (error) {
        // The request itself failed. Every id in this chunk gets that failure, unchanged, so a
        // caller still distinguishes "offline" from "not found" the way it always could.
        for (const id of chunk) batch.get(id)!.reject(error);
      } finally {
        // Cleared whether it worked or not: a failure must leave the next caller able to ask
        // again rather than joining a promise that has already rejected.
        for (const id of chunk) inFlight.delete(id);
      }
    }
  };

  const read = (id: string) => {
    const held = fresh.get(id);
    if (held && Date.now() - held.at < freshFor) return Promise.resolve(held.item);

    // Already on the wire. Join it rather than sending the same question again - which is what
    // several parts of a screen wanting the same card looked like before.
    const flying = inFlight.get(id);
    if (flying) return flying;

    const queued = waiting.get(id);
    if (queued) return queued.promise;

    const entry = defer<T>();
    waiting.set(id, entry);

    if (timer === null) {
      const busy = Date.now() - lastFlushAt < BUSY_FOR_MS;
      timer = setTimeout(() => void flush(), busy ? busyWindow : idleWindow);
    }

    return entry.promise;
  };

  /**
   * Forget everything, so the very next read goes to the server.
   *
   * Called by every write in `api.ts` that could change one of these. Deliberately clearing the
   * WHOLE map rather than one id: a vote is addressed by option rather than by poll, so the
   * writer does not know which poll it changed, and a map of a few dozen entries costs nothing
   * to rebuild. Being right here matters more than being surgical - showing somebody the tally
   * from before their own vote is the failure this must not have.
   */
  read.invalidate = () => fresh.clear();

  return read;
}
