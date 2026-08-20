import { NextResponse } from "next/server";
import { db } from "@/db";
import { detailTasks, tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { queueState, triggerWorkers } from "@/lib/taskQueue";
import { hasApiKey } from "@/lib/apiKeyStore";

export async function POST(req: Request) {
  try {
    // Make sure we have an API Key first before starting
    if (!hasApiKey()) {
      return NextResponse.json(
        { error: "API Key is not configured on the server. Please enter your API Key at the top first." },
        { status: 400 }
      );
    }

    const { prompt, concurrency } = await req.json();

    if (prompt !== undefined) {
      queueState.prompt = prompt;
    }

    if (concurrency !== undefined) {
      const parsedConcurrency = parseInt(concurrency, 10);
      if (parsedConcurrency >= 1 && parsedConcurrency <= 20) {
        queueState.concurrency = parsedConcurrency;
      }
    }

    // 自愈：进程刚启动时（状态为 idle）内存中不可能有存活的 worker，
    // 任何卡在 processing 的任务都是服务重启造成的孤儿任务，重置回队列。
    // 注意 paused 状态下可能有仍在收尾的请求，不能重置。
    if (queueState.status === "idle") {
      await Promise.all([
        db
          .update(tasks)
          .set({ status: "pending", errorMessage: null, updatedAt: new Date() })
          .where(eq(tasks.status, "processing")),
        db
          .update(detailTasks)
          .set({ status: "pending", errorMessage: null, updatedAt: new Date() })
          .where(eq(detailTasks.status, "processing")),
      ]);
    }

    // Set queue status to running
    queueState.status = "running";

    // Trigger workers to pull and process tasks
    triggerWorkers();

    return NextResponse.json({
      success: true,
      queue: {
        status: queueState.status,
        concurrency: queueState.concurrency,
        activeCount: queueState.activeCount,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to start queue: " + err.message }, { status: 500 });
  }
}
