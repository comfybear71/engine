import { NextResponse } from "next/server";
import { startLocalWorker } from "@/lib/startLocalWorker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const result = await startLocalWorker();
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
