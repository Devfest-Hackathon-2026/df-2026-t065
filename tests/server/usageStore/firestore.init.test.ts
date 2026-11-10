import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * PR-F2 audit (MAJOR): the real SDK's authentication / GAPIC initialisation must
 * never produce an unhandled promise rejection. Each scenario of
 * tests/server/childProcess/firestoreInit.node.ts runs in a PLAIN Node child
 * process (no Vitest inside, Node's DEFAULT behaviour: an unhandled rejection
 * terminates the process with exit code 1) — TWICE:
 *   1. WITHOUT any listener: the process must end BY ITSELF (event loop drained,
 *      no process.exit) with exit code 0 — any unhandled rejection, even a late
 *      one, would end it with exit code 1;
 *   2. with OBSERVE=1: a listener only COUNTS unhandled rejections / uncaught
 *      exceptions until the "exit" event; both counts must be 0.
 * A child killed by the parent's time limit FAILS. Passing (1) is what proves
 * the fix — a listener can never be what keeps the process alive. Scenario N is
 * the negative control: a rejection left unhandled 6 s after the work must be
 * detected (exit 1 without listener, counted with it). Nothing reaches Google Cloud: authentication fails locally
 * (missing credential file) or is a stub, endpoints are 127.0.0.1, and the GCE
 * metadata server is never probed.
 */

const CHILD = join(process.cwd(), "tests/server/childProcess/firestoreInit.node.ts");
const REGISTER = join(process.cwd(), "tests/server/childProcess/tsRegister.mjs");

function runChild(
  scenario: string,
  observe: boolean,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; killed: boolean; result: Record<string, unknown> | undefined; final: Record<string, unknown> | undefined; out: string }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    NO_COLOR: "1",
    METADATA_SERVER_DETECTION: "none", // never probe the metadata server
    GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/allergy-bridge-test/key.json", // ADC fails locally (no such file)
    ...(observe ? { OBSERVE: "1" } : {}),
    ...extraEnv,
  };
  const args = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=DEP0123", "--import", REGISTER, CHILD, scenario];
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 45_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`;
      const parse = (tag: string) => {
        const line = stdout.split("\n").find((l) => l.startsWith(`${tag} `));
        return line ? (JSON.parse(line.slice(tag.length + 1)) as Record<string, unknown>) : undefined;
      };
      const e = err as (Error & { code?: number | string | null; killed?: boolean; signal?: string | null }) | null;
      const killed = !!e && (e.killed === true || e.signal === "SIGKILL");
      const code = !e ? 0 : typeof e.code === "number" ? e.code : null;
      resolve({ code, killed, result: parse("RESULT"), final: parse("FINAL"), out });
    });
  });
}

type Expectation = { env?: Record<string, string>; expect: Record<string, unknown>; expectExit?: number; expectFinal?: Record<string, number> };
const REST = { FIRESTORE_PREFER_REST: "true" };
const FAIL_CLOSED = { status: [503], code: ["AI_DISABLED"], starts: 0, leak: false };
const SCENARIOS: Record<string, Expectation> = {
  // A / B. Real ADC fails (missing credential file) — the PRODUCTION connector as is (REST requested in A; never used).
  A_rest_auth_failure: { env: REST, expect: { status: [503, 503], code: ["AI_DISABLED", "AI_DISABLED"], starts: 0, leak: false } },
  B_grpc_auth_failure: { expect: { status: [503, 503], code: ["AI_DISABLED", "AI_DISABLED"], starts: 0, leak: false } },
  // K. Emulator + REST requested, real ADC unusable (audit #2): gRPC to the emulator host, reservation works.
  K_emulator_rest_auth_failure: { env: REST, expect: { status: [200], code: [null], starts: 1, docs: 2 } },
  // K'. Emulator + REST requested, the emulator host closes every connection: fail closed.
  K2_emulator_rest_unreachable: { env: REST, expect: FAIL_CLOSED },
  // B'. Local TLS gRPC endpoint, authentication failing (stub).
  B2_local_tls_auth_failure: { expect: FAIL_CLOSED },
  // L / L2. The auth object is ready, the GAPIC initialisation fails (universe mismatch / the lookup throws) (audit #2).
  L_gapic_init_failure_after_auth: { expect: FAIL_CLOSED },
  L2_gapic_init_throws_after_auth: { expect: FAIL_CLOSED },
  // L3. Initialisation succeeded (getClient resolved), per-call credentials fail.
  L3_credentials_fail_after_init: { expect: { ...FAIL_CLOSED, getClientResolved: true } },
  // C. Normal initialisation and reservation (emulator mode → local fake gRPC server).
  C_normal_init: { expect: { status: [200], code: [null], starts: 1, docs: 2, commits: 2 } },
  // C'. Initialised; the server refuses the commit (UNAUTHENTICATED): nothing stored.
  C2_auth_ok_server_refuses: { expect: { ...FAIL_CLOSED, docs: 0 } },
  // C3. Commit fails (ABORTED) and the best-effort Rollback fails too: both handled.
  C3_commit_and_rollback_fail: { expect: { ...FAIL_CLOSED, rollbackSent: true } },
  // K3 / K4. GOOGLE_CLOUD_UNIVERSE_DOMAIN other than googleapis.com: refused before any client exists (emulator / TLS path).
  K3_universe_env_refused: { env: { GOOGLE_CLOUD_UNIVERSE_DOMAIN: "example.test" }, expect: { ...FAIL_CLOSED, rpcs: 0 } },
  K4_universe_env_refused_tls: { env: { GOOGLE_CLOUD_UNIVERSE_DOMAIN: "example.test" }, expect: { ...FAIL_CLOSED, credentialsLoaded: false } },
  // D. A failed initialisation is retried by the next call; the failed attempt sent nothing.
  D_retry_after_failure: { expect: { status: [503, 200], code: ["AI_DISABLED", null], starts: 1, attempts: 2, rpcsAfterFailure: 0, leak: false } },
  // E. Five concurrent calls share ONE initialisation (one client).
  E_shared_init: { expect: { creates: 1 } },
  // F. store_timeout first; the authentication failure inside the GAPIC initialisation arrives later.
  F_late_auth_failure: { expect: { decision: "store_timeout", ...FAIL_CLOSED } },
  // G. The call outlives the deadline and fails later (applied commit, late lost response); close() waits for it.
  G_ignored_deadline_late_failure: { expect: { decision: "store_timeout", closeWaited: true, stored: 1, commits: 1 } },
  // H. close() during the GAPIC initialisation: calls fail "closed", nothing is sent.
  H_close_during_init: { expect: { outcome: "closed", after: "closed", rpcs: 0 } },
  // I. Auth OK (stub) on a TLS channel that uses it; the endpoint closes every connection: fail closed, natural exit.
  I_auth_ok_tls_channel: { expect: { ...FAIL_CLOSED, authUsed: true } },
  // J. close() while a read is still running: the transaction settles (allowed) before the client closes.
  J_close_during_running_read: { expect: { outcome: "allowed", closeWaited: true } },
  // M. 3rd audit MAJOR: stored 5 / limit 5, found → missing: store_error, stored stays 5, 0 commits; route AI_DISABLED, 0 model starts.
  M_found_then_missing: {
    expect: { decision: "store_error", guardCommits: 0, storedAfterGuard: { integerValue: "5" }, routeCommits: 1, storedAfterRoute: { integerValue: "10" }, status: [503], code: ["AI_DISABLED"], starts: 0 },
  },
  // R1–R3. Rollback after a failed read: fails late / answers late / never answers — close() waits (bounded), natural exit.
  R1_rollback_fails_late: { expect: { outcome: "unknown_outcome", rollbacks: 1, commits: 0, closeWaited: true, closeBounded: true } },
  R2_close_waits_for_rollback: { expect: { outcome: "unknown_outcome", rollbacks: 1, commits: 0, closeWaited: true, closeBounded: true } },
  R3_rollback_never_answers: { expect: { outcome: "unknown_outcome", rollbacks: 1, commits: 0, closeWaited: true, closeBounded: true } },
  // R4. The rollback throws synchronously: the primary error is kept, no unhandled rejection, natural exit.
  R4_rollback_throws_synchronously: { expect: { outcome: "unknown_outcome", rollbacks: 1 } },
  // N. NEGATIVE CONTROL: an unhandled rejection 6 s after the work is done MUST be caught by this harness:
  //    exit 1 under Node's default behaviour; counted (1) with the observing listener.
  N_negative_control_late_unhandled: { expect: { scheduledLateRejection: true }, expectExit: 1, expectFinal: { unhandledRejection: 1 } },
};

describe.concurrent("FirestoreUsageStore × real SDK: initialisation failures never become unhandled rejections (plain Node child processes, natural exit)", () => {
  for (const [name, s] of Object.entries(SCENARIOS)) {
    it(`${name}: natural exit, ${s.expectExit === 1 ? "the late rejection IS detected (negative control)" : "exit 0 under Node's default behaviour, 0 unhandled rejections"}, expected outcome`, async () => {
      const [plain, observed] = await Promise.all([runChild(name, false, s.env), runChild(name, true, s.env)]);
      // 1. WITHOUT listener: Node's default behaviour decides the exit code.
      expect(plain.killed, plain.out.slice(-2000)).toBe(false); // killed by the parent's time limit = FAIL
      expect(plain.code, plain.out.slice(-2000)).toBe(s.expectExit ?? 0);
      // 2. WITH the observing listener: the process always exits normally; counts are taken at "exit".
      expect(observed.killed, observed.out.slice(-2000)).toBe(false);
      expect(observed.code, observed.out.slice(-2000)).toBe(0);
      expect(observed.final).toMatchObject({ unhandledRejection: 0, uncaughtException: 0, exitCode: 0, ...(s.expectFinal ?? {}) });
      for (const run of [plain, observed]) {
        expect(run.result, run.out.slice(-2000)).toBeDefined();
        expect(run.result).toMatchObject(s.expect);
      }
      if (name === "E_shared_init") {
        const outs = observed.result!.outs as string[];
        expect(outs).toContain("allowed");
        for (const o of outs) expect(["allowed", "store_error"]).toContain(o); // contention fails SAFELY, nothing else
      }
    }, 60_000);
  }
});
