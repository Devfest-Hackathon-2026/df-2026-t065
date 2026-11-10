import { types } from "node:util";

/*
 * Settling UNTRUSTED values from a store or a reservation hook (PR #5 second
 * audit, MAJOR-B).
 *
 * Handing an untrusted value to the Promise machinery (Promise.resolve(v),
 * `.catch(...)`, `Promise.race([...])`, returning it from a handler) makes the
 * engine read `v.then` again on EVERY derived promise. A hostile Proxy can
 * revoke itself in between, so a later read throws inside a promise job: the
 * derived promise rejects (escaping our try/catch) and a monitoring promise
 * such as `pending.catch(() => undefined)` becomes an unhandledRejection.
 *
 * Rule: the untrusted value is inspected ONCE, in the FIRST fulfillment handler
 * (or synchronously if it is not a native Promise), by `check`, which must
 * return our OWN safe value (a primitive or a fresh plain object). Only that
 * safe value ever flows into further promises. Every failure — a rejection, an
 * exception while subscribing, an exception inside `check` — becomes
 * `fallback`. The returned promise never rejects.
 *
 * ACCEPTANCE CONTRACT (PR #5 final audit, Promise subclass / Symbol.species):
 * a store / hook may return either
 *   (a) a plain synchronous value, validated directly by `check`, or
 *   (b) a VERIFIABLE NATIVE Promise: `util.types.isPromise` is true, its
 *       prototype is exactly the native `Promise.prototype`, it has NO own
 *       properties (no own `then`, `constructor`, symbols…), and the Promise
 *       intrinsics it relies on (`Promise.prototype.then`,
 *       `Promise.prototype.constructor`, `Promise[Symbol.species]`) are the ones
 *       captured when this module was loaded.
 * Every other Promise — a subclass (whatever its species), a native Promise
 * with an own `constructor`/`then`, a Promise from another realm — is REFUSED
 * WITHOUT SUBSCRIBING to it: `Promise.prototype.then` on such a value would
 * look up `constructor[Symbol.species]` and call a foreign constructor and its
 * resolve/reject functions in a later job, out of our control. The checks only
 * read prototypes and own-property DESCRIPTORS (no getter is invoked) and are
 * done on a value that `isPromise` already identified as a real Promise (not a
 * Proxy, so no trap runs). A verifiable Promise is subscribed with the `then`
 * captured at load time, so its species lookup resolves to the native Promise.
 *
 * Limits: if the value is a native Promise produced by the store/hook itself,
 * that promise's OWN resolution may already have read `then` on a hostile value
 * (that happens inside the producer, before we see it). A refused Promise is not
 * observed by us; if it later rejects, that rejection is the producer's own
 * (it is not subscribed to precisely because subscribing is unsafe). The
 * intrinsics are assumed pristine when this module loads.
 */

const NativePromise = Promise;
const NATIVE_PROMISE_PROTOTYPE: object = Promise.prototype;
const NATIVE_THEN = Promise.prototype.then;
const NATIVE_CTOR_DESCRIPTOR = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor");
const NATIVE_THEN_DESCRIPTOR = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
const NATIVE_SPECIES_DESCRIPTOR = Object.getOwnPropertyDescriptor(Promise, Symbol.species);

function sameDescriptor(a: PropertyDescriptor | undefined, b: PropertyDescriptor | undefined): boolean {
  if (!a || !b) return false;
  return a.value === b.value && a.get === b.get && a.set === b.set && a.writable === b.writable && a.configurable === b.configurable && a.enumerable === b.enumerable;
}

/** The Promise intrinsics are still the ones captured at load time (descriptor comparison only). */
function promiseIntrinsicsIntact(): boolean {
  return (
    NATIVE_CTOR_DESCRIPTOR?.value === NativePromise &&
    NATIVE_THEN_DESCRIPTOR?.value === NATIVE_THEN &&
    sameDescriptor(Object.getOwnPropertyDescriptor(NATIVE_PROMISE_PROTOTYPE, "constructor"), NATIVE_CTOR_DESCRIPTOR) &&
    sameDescriptor(Object.getOwnPropertyDescriptor(NATIVE_PROMISE_PROTOTYPE, "then"), NATIVE_THEN_DESCRIPTOR) &&
    sameDescriptor(Object.getOwnPropertyDescriptor(NativePromise, Symbol.species), NATIVE_SPECIES_DESCRIPTOR)
  );
}

/**
 * Contract (b) above. Precondition: `types.isPromise(value)` is true, so `value`
 * is a real Promise object (never a Proxy) and these reflective reads run no
 * user code.
 */
function isVerifiableNativePromise(value: object): boolean {
  return Object.getPrototypeOf(value) === NATIVE_PROMISE_PROTOTYPE && Reflect.ownKeys(value).length === 0 && promiseIntrinsicsIntact();
}
export function settleUntrusted<T>(value: unknown, check: (v: unknown) => T, fallback: T): Promise<T> {
  const safeCheck = (v: unknown): T => {
    try {
      return check(v);
    } catch {
      return fallback;
    }
  };
  let isNativePromise = false;
  try {
    isNativePromise = types.isPromise(value); // V8 internal check; never invokes user code
  } catch {
    return Promise.resolve(fallback);
  }
  if (!isNativePromise) {
    // Not a Promise (a plain value, a Proxy, a "thenable"): validated directly and
    // never assimilated — its `then` (if any) is never read or called by us.
    return NativePromise.resolve(safeCheck(value));
  }
  let verifiable = false;
  try {
    verifiable = isVerifiableNativePromise(value as object);
  } catch {
    verifiable = false;
  }
  // A Promise subclass, a Promise with own properties or changed intrinsics: refused
  // WITHOUT subscribing (its species / constructor is never consulted).
  if (!verifiable) return NativePromise.resolve(fallback);
  return new NativePromise<T>((resolve) => {
    try {
      NATIVE_THEN.call(
        value as Promise<unknown>,
        (v: unknown) => resolve(safeCheck(v)),
        () => resolve(fallback),
      );
    } catch {
      resolve(fallback);
    }
  });
}
