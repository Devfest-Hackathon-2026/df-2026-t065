import { handleAnalyzeMenu } from "@/server/analyzeMenu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // The full environment is passed so that SDK endpoint overrides (in any letter
  // case) can be detected and refused; NODE_ENV is read explicitly.
  return handleAnalyzeMenu(req, { ...process.env, NODE_ENV: process.env.NODE_ENV });
}
