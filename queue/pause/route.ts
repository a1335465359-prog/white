import { NextResponse } from "next/server";
import { queueState } from "@/lib/taskQueue";

export async function POST() {
  try {
    queueState.status = "paused";
    return NextResponse.json({
      success: true,
      queue: {
        status: queueState.status,
        concurrency: queueState.concurrency,
        activeCount: queueState.activeCount,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to pause queue: " + err.message }, { status: 500 });
  }
}
