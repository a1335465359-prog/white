import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { detailTasks, tasks } from "@/db/schema";
import { queueState, triggerWorkers } from "@/lib/taskQueue";

function removeStoredFile(storedPath: string | null): void {
  if (!storedPath) return;
  const storageRoot = path.join(process.cwd(), "storage");
  const absolutePath = path.join(process.cwd(), storedPath);
  if (!absolutePath.startsWith(storageRoot)) return;
  try {
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch {
    // Cleanup failure should not block a new generation.
  }
}

export async function POST(request: Request) {
  try {
    const { taskId } = await request.json();
    const id = Number(taskId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "无效的主图任务。" }, { status: 400 });
    }

    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!task) {
      return NextResponse.json({ error: "主图任务不存在。" }, { status: 404 });
    }

    const oldDetails = await db.select().from(detailTasks).where(eq(detailTasks.taskId, id));
    removeStoredFile(task.processedPath);
    for (const detail of oldDetails) removeStoredFile(detail.resultPath);

    await db.delete(detailTasks).where(eq(detailTasks.taskId, id));
    const [updated] = await db
      .update(tasks)
      .set({
        status: "pending",
        processedPath: null,
        processedUrl: null,
        errorMessage: null,
        retryCount: 0,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id))
      .returning();

    if (queueState.status === "running") triggerWorkers();

    return NextResponse.json({ success: true, task: updated });
  } catch (error: any) {
    return NextResponse.json(
      { error: `重新生成失败：${error.message || "未知错误"}` },
      { status: 500 }
    );
  }
}
