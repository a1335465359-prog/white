import { NextResponse } from "next/server";
import { db } from "@/db";
import { detailTasks, tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

export async function POST(req: Request) {
  try {
    const { taskId } = await req.json();

    if (!taskId) {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 });
    }

    // Retrieve task to find files
    const found = await db.select().from(tasks).where(eq(tasks.id, taskId));

    if (found.length === 0) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const task = found[0];
    const attachedDetails = await db
      .select()
      .from(detailTasks)
      .where(eq(detailTasks.taskId, taskId));

    // Delete original file
    if (task.originalPath) {
      try {
        const fullOrigPath = path.join(process.cwd(), task.originalPath);
        if (fs.existsSync(fullOrigPath)) {
          fs.unlinkSync(fullOrigPath);
        }
      } catch (e) {
        console.error("Error deleting original file:", e);
      }
    }

    // Delete processed file
    if (task.processedPath) {
      try {
        const fullProcPath = path.join(process.cwd(), task.processedPath);
        if (fs.existsSync(fullProcPath)) {
          fs.unlinkSync(fullProcPath);
        }
      } catch (e) {
        console.error("Error deleting processed file:", e);
      }
    }

    // Delete local result files belonging to attached detail tasks
    for (const detail of attachedDetails) {
      if (!detail.resultPath) continue;
      try {
        const detailPath = path.join(process.cwd(), detail.resultPath);
        if (fs.existsSync(detailPath)) fs.unlinkSync(detailPath);
      } catch (e) {
        console.error("Error deleting detail image:", e);
      }
    }

    // Delete database entry (detail rows are removed through the FK cascade)
    await db.delete(tasks).where(eq(tasks.id, taskId));

    return NextResponse.json({ success: true, taskId });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to delete task: " + err.message }, { status: 500 });
  }
}
