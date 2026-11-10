/*
 * Hostile and normal "Promise-like" values for the Promise subclass /
 * Symbol.species audit (PR #5, final MAJOR). Shared by the in-process test
 * (tests/server/promiseSpecies.test.ts) and the separate-Node-process scenario
 * (tests/server/childProcess/species.child.ts). SYNTHETIC values only.
 */

export type Scenario = {
  name: string;
  /** true: must be refused (store_error, no model start); false: must be accepted. */
  refuse: boolean;
  make: (value: object) => unknown;
  /** Invocation counter for getters that must NEVER run (if any). */
  getterCalls?: () => number;
};

/** A species constructor whose resolve/reject functions throw when called (the audit's input). */
function throwingSpeciesCtor() {
  return function HostileCapability(this: unknown, executor: (res: () => never, rej: () => never) => void) {
    executor(
      () => {
        throw new Error("SYNTHETIC species resolve");
      },
      () => {
        throw new Error("SYNTHETIC species reject");
      },
    );
  };
}

export function scenarios(): Scenario[] {
  class EvilSpecies<T> extends Promise<T> {
    static override get [Symbol.species]() {
      return throwingSpeciesCtor() as unknown as PromiseConstructor;
    }
  }
  class PlainSubclass<T> extends Promise<T> {}
  let speciesGetterCalls = 0;
  class CountingSpecies<T> extends Promise<T> {
    static override get [Symbol.species]() {
      speciesGetterCalls++;
      return Promise;
    }
  }
  let ctorGetterCalls = 0;
  let thenCalls = 0;

  return [
    { name: "a Promise subclass with a hostile Symbol.species (audit repro)", refuse: true, make: (v) => EvilSpecies.resolve(v) },
    { name: "a plain Promise subclass", refuse: true, make: (v) => PlainSubclass.resolve(v) },
    {
      name: "a native Promise whose own `constructor` is replaced by a hostile subclass",
      refuse: true,
      make: (v) => Object.defineProperty(Promise.resolve(v), "constructor", { value: EvilSpecies, configurable: true }),
    },
    {
      name: "a native Promise whose own `constructor` is a getter",
      refuse: true,
      make: (v) =>
        Object.defineProperty(Promise.resolve(v), "constructor", {
          configurable: true,
          get() {
            ctorGetterCalls++;
            return Promise;
          },
        }),
      getterCalls: () => ctorGetterCalls,
    },
    { name: "a Promise subclass whose Symbol.species is a counting getter", refuse: true, make: (v) => CountingSpecies.resolve(v), getterCalls: () => speciesGetterCalls },
    {
      name: "a native Promise with an own `then`",
      refuse: true,
      make: (v) => Object.defineProperty(Promise.resolve(v), "then", { value: Promise.prototype.then, configurable: true }),
    },
    {
      name: "a revoked Proxy",
      refuse: true,
      make: (v) => {
        const { proxy, revoke } = Proxy.revocable(v, {});
        revoke();
        return proxy;
      },
    },
    {
      name: "a thenable that is not a Promise",
      refuse: true,
      make: (v) => ({
        then(resolve: (x: unknown) => void) {
          thenCalls++;
          resolve(v);
        },
      }),
      getterCalls: () => thenCalls,
    },
    { name: "a rejected native Promise", refuse: true, make: () => Promise.reject(new Error("SYNTHETIC_SECRET_TOKEN")) },
    { name: "a result with a custom prototype (inside a native Promise)", refuse: true, make: (v) => Promise.resolve(Object.assign(Object.create({ x: 1 }), v)) },
    { name: "a normal native Promise", refuse: false, make: (v) => Promise.resolve(v) },
    { name: "a normal synchronous result", refuse: false, make: (v) => ({ ...v }) },
  ];
}
