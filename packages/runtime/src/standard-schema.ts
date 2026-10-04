/** Standard Schema v1 structural contract (https://standardschema.dev/schema).
 * Types may be copied by consumers; no validation-library dependency is needed.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** Standard properties shared by conforming validation libraries. */
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

/** Supporting Standard Schema v1 types. */
export namespace StandardSchemaV1 {
  /** Version, vendor, validation function and optional inference metadata. */
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  /** Either a validated output or a collection of validation issues. */
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  /** A successful validation, including transformed output. */
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  /** A failed validation. */
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  /** A validation message and its optional input path. */
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  /** Wrapped path key used by some validators. */
  export interface PathSegment {
    readonly key: PropertyKey;
  }
  /** Schema input and output inference metadata. */
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  /** Infer a schema's accepted input type. */
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"];
  /** Infer a schema's validated output type. */
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}
