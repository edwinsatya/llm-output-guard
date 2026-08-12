/**
 * The executable. Nothing but a call to `main`, unconditionally.
 *
 * Keeping the entry point this thin is the point: the previous version decided
 * whether to run by inspecting `process.argv[1]`, which is a different string
 * when npm invokes it through a bin symlink, so the CLI silently did nothing.
 * A module that is only ever an entry point does not need to ask whether it is
 * one.
 */
import { main } from './cli.js';

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
