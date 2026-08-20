import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { detailTasks, tasks, type DetailType } from "@/db/schema";
import { queueState, triggerWorkers } from "@/lib/taskQueue";

const VALID_DETAIL_TYPES: DetailType[] = ["collar", "cuff", "pocket", "hem"];

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const payload = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const rawTaskIds: unknown[] = Array.isArray(payload.taskIds) ? payload.taskIds : [];
    const rawDetailTypes: unknown[] = Array.isArray(payload.detailTypes) ? payload.detailTypes : [];

    const taskIds = [...new Set(
      rawTaskIds
        .map((value: unknown) => Number(value))
        .filter((id: number) => Number.isInteger(id) && id > 0)
    )];
    const detailTypes = [...new Set(
      rawDetailTypes.filter(
        (type: unknown): type is DetailType =>
          typeof type === "string" && VALID_DETAIL_TYPES.includes(type as DetailType)
      )
    )];

    if (taskIds.length === 0 || detailTypes.length === 0) {
      return NextResponse.json({ error: "请选择至少一张已完成主图和一个细节位置。" }, { status: 400 });
    }

    if (taskIds.length > 200) {
      return NextResponse.json({ error: "单次最多为 200 张主图生成细节图。" }, { status: 400 });
    }

    const sourceTasks = await db
      .select()
      .from(tasks)
      .where(and(inArray(tasks.id, taskIds), eq(tasks.status, "success")));

    if (sourceTasks.length === 0) {
      return NextResponse.json({ error: "所选图片尚未完成白底主图，暂时不能生成细节图。" }, { status: 400 });
    }

    let createdOrQueued = 0;
    for (const source of sourceTasks) {
      if (!source.processedPath) continue;

      for (const detailType of detailTypes) {
        const [existing] = await db
          .select()
          .from(detailTasks)
          .where(and(eq(detailTasks.taskId, source.id), eq(detailTasks.detailType, detailType)))
          .limit(1);

        if (existing) {
          // Same detail requested again = regenerate it, while retaining no stale preview.
          await db
            .update(detailTasks)
            .set({
              sourcePath: source.processedPath,
              resultPath: null,
              resultUrl: null,
              status: "pending",
              errorMessage: null,
              retryCount: 0,
              updatedAt: new Date(),
            })
            .where(eq(detailTasks.id, existing.id));
        } else {
          await db.insert(detailTasks).values({
            taskId: source.id,
            detailType,
            sourcePath: source.processedPath,
            status: "pending",
            retryCount: 0,
          });
        }
        createdOrQueued += 1;
      }
    }

    if (queueState.status === "running") {
      triggerWorkers();
    }

    return NextResponse.json({
      success: true,
      count: createdOrQueued,
      sourceCount: sourceTasks.length,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: `创建细节图任务失败：${error.message || "未知错误"}` },
      { status: 500 }
    );
  }
}
