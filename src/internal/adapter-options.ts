/**
 * The option surface every provider adapter shares.
 *
 * Defined once rather than per subpath so the adapters cannot drift: the
 * promise `./openai` makes is that someone who has read the `./ai-sdk` docs can
 * guess it, and two hand-maintained copies of an interface is how that promise
 * quietly stops being true.
 *
 * ## This type is INTERNAL. It is not public API, at 1.0 or after.
 *
 * It is exported from no subpath and is not reachable by any import path a user
 * has. What is public is each adapter's own `OutputGuardOptions`, and those are
 * separate contracts that happen to share a base today.
 *
 * The distinction is what keeps a future adapter-specific option cheap. When
 * `./openai` needs something only OpenAI has, it goes on *that* subpath's
 * `OutputGuardOptions` and nothing else moves. Nobody has to widen a shared type
 * for one provider's concern, and nobody has to split a frozen public interface
 * after 1.0 -- because the shared thing was never frozen in the first place.
 *
 * Rules that follow from that, worth stating because they are easy to erode:
 *
 * - Anything here must be genuinely common to every adapter. If it needs an
 *   "only applies to X" caveat, it belongs on X's own options instead.
 * - Adapters are free to stop extending this. Convergence is the goal, not the
 *   constraint; if two adapters genuinely diverge, copying the fields into both
 *   is the correct move and breaks no promise.
 * - `DegenerateAction` is re-exported from each subpath and therefore *is*
 *   public through those paths. Changing its members is a breaking change to
 *   both, and semver applies per subpath.
 */
import type { Verdict } from '../types.js';

export type DegenerateAction = 'throw' | 'abort' | 'ignore';

export interface AdapterGuardOptions {
  /**
   * What to do when output is judged degenerate. Default `'throw'`.
   *
   * - `'throw'` errors the call with a `DegenerateOutputError`, which
   *   `.retryable` marks as safe for your fallback layer to act on. On a
   *   stream this also cancels the upstream request, so the tokens you have
   *   not been billed for yet never get generated.
   * - `'abort'` ends the stream cleanly and keeps whatever arrived first.
   *   Same token saving, no exception to handle -- use it when a partial
   *   answer beats no answer.
   * - `'ignore'` reports through `onVerdict` and changes nothing. This is the
   *   setting to roll out with: watch your own traffic before letting any
   *   threshold fail a request.
   */
  onDegenerate?: DegenerateAction;
  /**
   * Every verdict, passing or failing, once per call. Send the scores to your
   * metrics -- a week of them is what turns the shipped thresholds into
   * thresholds you can defend for your own traffic.
   *
   * Log `verdict.modes` alongside `verdict.scores`. `TAIL_LOOP` measures words
   * on spaced scripts and characters on Chinese, Japanese and Thai, and those
   * are different distributions; pooled into one histogram they describe
   * neither.
   */
  onVerdict?: (verdict: Verdict, context: { streaming: boolean }) => void;
}
