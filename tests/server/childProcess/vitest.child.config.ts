import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/*
 * Runs ONLY the hostile-value scenarios, in a SEPARATE Node process started by
 * tests/server/prod12Revise2.test.ts (MAJOR-B: no unhandledRejection). Not part
 * of the normal test run (the file does not match tests/**\/*.test.ts).
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("../../../src", import.meta.url)) },
  },
  test: {
    include: ["tests/server/childProcess/*.child.ts"],
    environment: "node",
    // Fail the child run on ANY unhandled error (Vitest's own detection) as well as on our listener.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
