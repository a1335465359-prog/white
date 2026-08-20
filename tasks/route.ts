import { NextResponse } from "next/server";
import { db } from "@/db";
import { detailTasks, tasks } from "@/db/schema";
import { queueState } from "@/lib/taskQueue";
import { desc } from "drizzle-orm";

/**
 * Legacy task rows stored bare /uploads/... or /processed/... URLs that
 * pointed directly at public/ (not served in production for runtime files).
 * Rewrite them to go through the /api/files serving route.
 */
function normalizeUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("/uploads/") || url.startsWith("/processed/")) {
    return `/api/files${url}`;
  }
  return url;
}

export async function GET() {
  try {
    // Fetch all tasks from the DB, newest first
    const [rawTasks, rawDetails] = await Promise.all([
      db.select().from(tasks).orderBy(desc(tasks.id)),
      db.select().from(detailTasks).orderBy(desc(detailTasks.id)),
    ]);

    const detailsByTask = new Map<number, typeof rawDetails>();
    for (const detail of rawDetails) {
      const bucket = detailsByTask.get(detail.taskId) ?? [];
      bucket.push({ ...detail, resultUrl: normalizeUrl(detail.resultUrl) });
      detailsByTask.set(detail.taskId, bucket);
    }

    const allTasks = rawTasks.map((t) => ({
      ...t,
      originalUrl: normalizeUrl(t.originalUrl),
      processedUrl: normalizeUrl(t.processedUrl),
      details: detailsByTask.get(t.id) ?? [],
    }));

    const detailStats = { pending: 0, processing: 0, success: 0, failed: 0, total: rawDetails.length };
    for (const detail of rawDetails) {
      detailStats[detail.status] += 1;
    }

    // Calculate counts in a simple iteration
    let pending = 0;
    let processing = 0;
    let success = 0;
    let failed = 0;

    for (const t of allTasks) {
      if (t.status === "pending") pending++;
      else if (t.status === "processing") processing++;
      else if (t.status === "success") success++;
      else if (t.status === "failed") failed++;
    }

    return NextResponse.json({
      tasks: allTasks,
      queue: {
        status: queueState.status,
        concurrency: queueState.concurrency,
        activeCount: queueState.activeCount,
      },
      stats: {
        pending,
        processing,
        success,
        failed,
        total: allTasks.length,
      },
      detailStats,
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to retrieve tasks: " + err.message }, { status: 500 });
  }
}
