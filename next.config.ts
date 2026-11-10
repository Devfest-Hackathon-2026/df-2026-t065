import type { NextConfig } from "next";
import { randomUUID } from "node:crypto";

// One identifier is embedded in the client and in Next's build artifacts.
const offlineBuildId = randomUUID();

const nextConfig: NextConfig = {
  generateBuildId: () => offlineBuildId,
  env: { NEXT_PUBLIC_OFFLINE_BUILD_ID: offlineBuildId },
  // Keep the shared development rules under human control.
  agentRules: false,
  // Cloud Run (PR2) runs the standalone server output.
  output: "standalone",
  poweredByHeader: false,
  // PR-F2: the Firestore SDK (its GAPIC client) and google-gax load proto files and
  // modules at run time; keep both real node_modules packages in the standalone
  // output (not bundled), so the usage store and the SDK share ONE google-gax.
  serverExternalPackages: ["@google-cloud/firestore", "google-gax"],
};

export default nextConfig;
