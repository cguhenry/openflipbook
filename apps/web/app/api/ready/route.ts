import { NextResponse } from "next/server";
import { readCoreReadiness } from "@/lib/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const readiness = await readCoreReadiness();
  return NextResponse.json(readiness, { status: readiness.ok ? 200 : 503 });
}
