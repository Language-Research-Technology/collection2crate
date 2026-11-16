// The progress side of the hook contract, in one place.
//
// A tap declares how much of the build it represents (`weight`) and, when
// conditional, `activeWhen(ctx)`; collection2crate sums the weights of the taps
// that will actually run and hands each one an ordered slice of the main
// progress bar. The handler then reports only its own position within that
// slice — a fraction in [0,1], never a global percentage, and never a
// "12/40" string for the host to parse back out of the log.
//
// Everything here exists so a plugin never has to feel for whether the host
// supports any of that. progressFor(ctx) always returns the same three-call
// shape; against a collection2crate that predates ctx.progress (or any other
// host, or a unit test passing a bare object as ctx) the calls are no-ops,
// so a plugin stays runnable rather than throwing partway through a build.
// Keep it dependency-free for the same reason the rest of this package is.

const NOOP = Object.freeze({
  start() {},
  report() {},
  done() {},
});

function clampFraction(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * @param {object} ctx  the pipeline context handed to a hook handler
 * @returns {{start(label?: string): void,
 *            report(fraction: number, label?: string): void,
 *            done(): void}}
 */
export function progressFor(ctx) {
  const p = ctx && ctx.progress;
  if (!p) return NOOP;
  return {
    start(label) {
      p.start?.(label);
    },
    report(fraction, label) {
      p.report?.(clampFraction(fraction), label);
    },
    done() {
      p.done?.();
    },
  };
}

/**
 * Progress for a plain "process N things in a loop" tap — the shape most
 * handlers here want. Returns a `report(index)` taking the zero-based index
 * of the item just finished, so call sites stay `tick(i)` rather than
 * repeating the `(i + 1) / total` arithmetic (and its divide-by-zero guard)
 * in every plugin.
 *
 *   const tick = countedProgress(ctx, files.length, "Reading files…");
 *   for (let i = 0; i < files.length; i++) { ...; tick(i, `${files[i].name}`); }
 *   tick.done();
 */
export function countedProgress(ctx, total, startLabel) {
  const progress = progressFor(ctx);
  progress.start(startLabel);
  const tick = (index, label) => {
    progress.report(total > 0 ? (index + 1) / total : 1, label);
  };
  tick.done = () => progress.done();
  return tick;
}
