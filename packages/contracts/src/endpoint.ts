import type { z } from "zod";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Extracts `:name` segments from a path template: "/a/:x/b/:y" -> "x" | "y". */
export type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`> : P extends `${string}:${infer Name}` ? Name : never;

export type Endpoint<P extends string = string, Q extends z.ZodType | undefined = z.ZodType | undefined, B extends z.ZodType | undefined = z.ZodType | undefined, R extends z.ZodType = z.ZodType> = {
  readonly method: Method;
  readonly path: P;
  readonly query?: Q;
  readonly body?: B;
  readonly response: R;
  /** "text" for non-JSON bodies such as CSV exports. Default JSON. */
  readonly responseType?: "json" | "text";
};

export function endpoint<const P extends string, R extends z.ZodType, Q extends z.ZodType | undefined = undefined, B extends z.ZodType | undefined = undefined>(def: {
  method: Method;
  path: P;
  response: R;
  query?: Q;
  body?: B;
  responseType?: "json" | "text";
}): Endpoint<P, Q, B, R> {
  return def;
}

type Empty = Record<never, never>;
type Params<P extends string> = [ParamNames<P>] extends [never] ? Empty : { params: Record<ParamNames<P>, string> };
type Body<B> = B extends z.ZodType ? { body: z.input<B> } : Empty;
type Query<Q> = Q extends z.ZodType ? { query?: z.input<Q> } : Empty;

export type CallInput<E extends Endpoint> = E extends Endpoint<infer P, infer Q, infer B, z.ZodType> ? Params<P> & Body<B> & Query<Q> : never;
export type CallOutput<E extends Endpoint> = z.output<E["response"]>;
export type CallArgs<E extends Endpoint> = keyof CallInput<E> extends never ? [input?: undefined] : [input: CallInput<E>];
