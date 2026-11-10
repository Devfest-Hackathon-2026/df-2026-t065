import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// .next/static is copied by the existing standalone Docker build. No public/
// directory or credentials are required in the runtime container.
export async function GET() {
  try {
    const source = await readFile(join(process.cwd(), ".next/static/offline/worker.js"), "utf8");
    return new Response(source, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "Service-Worker-Allowed": "/",
      },
    });
  } catch {
    return new Response("Offline worker unavailable", { status: 503 });
  }
}
