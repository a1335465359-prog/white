import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { queueState, triggerWorkers } from "@/lib/taskQueue";

export async function POST(req: Request) {
  try {
    const { taskId } = await req.json();

    if (!taskId) {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 });
    }

    // Reset task to pending
    const updated = await db
      .update(tasks)
      .set({
        status: "pending",
        errorMessage: null,
        retryCount: 0,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId))
      .returning();

    if (updated.length === 0) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Trigger workers if the queue is running
    if (queueState.status === "running") {
      triggerWorkers();
    }

    return NextResponse.json({ success: true, task: updated[0] });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to retry task: " + err.message }, { status: 500 });
  }
}
