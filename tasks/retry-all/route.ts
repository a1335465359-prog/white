import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { queueState, triggerWorkers } from "@/lib/taskQueue";

export async function POST() {
  try {
    // Reset all failed tasks to pending
    const updated = await db
      .update(tasks)
      .set({
        status: "pending",
        errorMessage: null,
        retryCount: 0,
        updatedAt: new Date(),
      })
      .where(eq(tasks.status, "failed"))
      .returning();

    // Trigger workers if queue is running
    if (queueState.status === "running") {
      triggerWorkers();
    }

    return NextResponse.json({ success: true, count: updated.length });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to retry all tasks: " + err.message }, { status: 500 });
  }
}
