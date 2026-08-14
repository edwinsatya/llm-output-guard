/**
 * The Standard Schema v1 interface, vendored.
 *
 * Copied rather than depended on because the spec is *types only* -- it ships no
 * runtime code at all, so there is nothing to import at runtime and vendoring
 * costs nothing but these lines. That is what lets `schema` accept Zod, Valibot
 * and ArkType while this package keeps having zero dependencies, which is the
 * claim the whole README is built on.
 *
 * Kept in `src/` rather than `src/internal/` because {@link StandardSchemaV1} is
 * public: it is the type of the `schema` option, so a consumer writing their own
 * validator needs to be able to name it.
 *
 * See https://standardschema.dev. The shape below is the full v1 spec, minus the
 * inference helpers this package has no use for.
 */

/** A validator implementing Standard Schema v1. Zod 4, Valibot and ArkType all do. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    /** The version number of the spec. */
    readonly version: 1;
    /** The library that produced this schema, e.g. `'zod'`. */
    readonly vendor: string;
    /**
     * Validates a value.
     *
     * The spec permits returning a promise. This package cannot use one --
     * `checkOutput` is synchronous, and that is a load-bearing promise rather
     * than an implementation detail: it is what makes the guard safe on a hot
     * path and trivial to test. A validator that returns a promise is rejected
     * loudly instead of being silently treated as a pass. See `jsonScore`.
     */
    readonly validate: (
      value: unknown,
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  type Result<Output> = SuccessResult<Output> | FailureResult;

  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  interface PathSegment {
    readonly key: PropertyKey;
  }

  interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
}
