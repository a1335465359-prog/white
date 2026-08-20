import fs from "fs";
import path from "path";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { detailTasks, tasks, type DetailType } from "@/db/schema";
import { callImageModel, sanitizeError } from "./imageApi";
import { getApiKey } from "./apiKeyStore";
import { buildDetailPrompt, DEFAULT_WHITE_PROMPT } from "./prompts";

export function ensureDirectories(): void {
  const baseDir = path.join(process.cwd(), "storage");
  for (const directory of [
    baseDir,
    path.join(baseDir, "uploads"),
    path.join(baseDir, "processed"),
  ]) {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }
}

export type QueueStatus = "idle" | "running" | "paused";

interface QueueState {
  status: QueueStatus;
  concurrency: number;
  activeCount: number;
  prompt: string;
}

type WorkItem =
  | { kind: "main"; id: number; sourcePath: string; originalName: string }
  | { kind: "detail"; id: number; taskId: number; sourcePath: string; detailType: DetailType };

const globalForQueue = globalThis as typeof globalThis & {
  __queueState?: QueueState;
};

export const queueState: QueueState = globalForQueue.__queueState ?? {
  status: "idle",
  concurrency: 5,
  activeCount: 0,
  prompt: "",
};

globalForQueue.__queueState = queueState;

function mimeFromFilename(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function isNonRetryableError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return (
    text.includes("401") ||
    text.includes("unauthorized") ||
    text.includes("403") ||
    text.includes("forbidden")
  );
}

async function waitForRetry(attempt: number): Promise<void> {
  const baseDelay = attempt === 1 ? 5_000 : attempt === 2 ? 15_000 : 45_000;
  const jitter = Math.floor(Math.random() * (attempt === 1 ? 2_000 : attempt === 2 ? 4_000 : 8_000));
  await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
}

async function generateWithRetries(
  label: string,
  execute: () => Promise<{ buffer: Buffer; extension: string }>,
  onRetry: (attempt: number, message: string) => Promise<void>
): Promise<{ buffer: Buffer; extension: string }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      const message = sanitizeError(lastError);
      console.warn(`${label}: retry ${attempt}/3 after ${message.slice(0, 180)}`);
      await onRetry(attempt, message);
      await waitForRetry(attempt);
    }

    try {
      return await execute();
    } catch (error) {
      lastError = error;
      if (isNonRetryableError(error)) break;
    }
  }

  throw new Error(sanitizeError(lastError));
}

async function claimNextWorkItem(): Promise<WorkItem | null> {
  // Main images have priority, so a newly uploaded batch stays responsive.
  const [mainCandidate] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.status, "pending"))
    .orderBy(asc(tasks.id))
    .limit(1);

  if (mainCandidate) {
    const claimed = await db
      .update(tasks)
      .set({ status: "processing", updatedAt: new Date() })
      .where(and(eq(tasks.id, mainCandidate.id), eq(tasks.status, "pending")))
      .returning();

    if (claimed[0]) {
      return {
        kind: "main",
        id: claimed[0].id,
        sourcePath: claimed[0].originalPath,
        originalName: claimed[0].originalName,
      };
    }
  }

  const [detailCandidate] = await db
    .select()
    .from(detailTasks)
    .where(eq(detailTasks.status, "pending"))
    .orderBy(asc(detailTasks.id))
    .limit(1);

  if (!detailCandidate) return null;

  const claimed = await db
    .update(detailTasks)
    .set({ status: "processing", updatedAt: new Date() })
    .where(and(eq(detailTasks.id, detailCandidate.id), eq(detailTasks.status, "pending")))
    .returning();

  if (!claimed[0]) return null;

  return {
    kind: "detail",
    id: claimed[0].id,
    taskId: claimed[0].taskId,
    sourcePath: claimed[0].sourcePath,
    detailType: claimed[0].detailType,
  };
}

async function readSource(sourcePath: string): Promise<{ data: string; mimeType: string }> {
  const fullPath = path.join(process.cwd(), sourcePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error("参考图片在本地存储中不存在，请重新生成主图后再试。");
  }
  return {
    data: fs.readFileSync(fullPath).toString("base64"),
    mimeType: mimeFromFilename(sourcePath),
  };
}

async function processMainTask(item: Extract<WorkItem, { kind: "main" }>): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    await db
      .update(tasks)
      .set({
        status: "failed",
        errorMessage: "API Key 不存在或服务已重启，请重新填写 Key。",
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, item.id));
    return;
  }

  try {
    const source = await readSource(item.sourcePath);
    const result = await generateWithRetries(
      `Main task ${item.id}`,
      () => callImageModel(apiKey, source.data, source.mimeType, queueState.prompt || DEFAULT_WHITE_PROMPT),
      async (attempt, message) => {
        await db
          .update(tasks)
          .set({
            errorMessage: `请求繁忙，正在自动重试（${attempt}/3）：${message}`,
            retryCount: attempt,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, item.id));
      }
    );

    ensureDirectories();
    const extension = result.extension || "jpg";
    const baseName = path.parse(item.originalName).name;
    const filename = `${Date.now()}_${item.id}_${baseName}_white.${extension}`;
    const storedPath = path.join("storage", "processed", filename);
    fs.writeFileSync(path.join(process.cwd(), storedPath), result.buffer);

    await db
      .update(tasks)
      .set({
        status: "success",
        processedPath: storedPath,
        processedUrl: `/api/files/processed/${filename}`,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, item.id));
  } catch (error) {
    await db
      .update(tasks)
      .set({
        status: "failed",
        errorMessage: sanitizeError(error),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, item.id));
  }
}

async function processDetailTask(item: Extract<WorkItem, { kind: "detail" }>): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    await db
      .update(detailTasks)
      .set({
        status: "failed",
        errorMessage: "API Key 不存在或服务已重启，请重新填写 Key。",
        updatedAt: new Date(),
      })
      .where(eq(detailTasks.id, item.id));
    return;
  }

  try {
    const source = await readSource(item.sourcePath);
    const result = await generateWithRetries(
      `Detail task ${item.id}`,
      () => callImageModel(apiKey, source.data, source.mimeType, buildDetailPrompt(item.detailType)),
      async (attempt, message) => {
        await db
          .update(detailTasks)
          .set({
            errorMessage: `请求繁忙，正在自动重试（${attempt}/3）：${message}`,
            retryCount: attempt,
            updatedAt: new Date(),
          })
          .where(eq(detailTasks.id, item.id));
      }
    );

    ensureDirectories();
    const extension = result.extension || "jpg";
    const filename = `${Date.now()}_detail_${item.taskId}_${item.detailType}.${extension}`;
    const storedPath = path.join("storage", "processed", filename);
    fs.writeFileSync(path.join(process.cwd(), storedPath), result.buffer);

    await db
      .update(detailTasks)
      .set({
        status: "success",
        resultPath: storedPath,
        resultUrl: `/api/files/processed/${filename}`,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(detailTasks.id, item.id));
  } catch (error) {
    await db
      .update(detailTasks)
      .set({
        status: "failed",
        errorMessage: sanitizeError(error),
        updatedAt: new Date(),
      })
      .where(eq(detailTasks.id, item.id));
  }
}

async function workerLoop(): Promise<void> {
  ensureDirectories();

  while (queueState.status === "running") {
    if (queueState.activeCount >= queueState.concurrency) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }

    const item = await claimNextWorkItem();
    if (!item) return;

    queueState.activeCount += 1;
    const run = item.kind === "main" ? processMainTask(item) : processDetailTask(item);
    run
      .catch((error) => console.error(`Queue item ${item.kind}:${item.id} crashed`, sanitizeError(error)))
      .finally(() => {
        queueState.activeCount = Math.max(0, queueState.activeCount - 1);
        triggerWorkers();
      });
  }
}

/** Dispatch exactly enough workers for the shared main/detail concurrency limit. */
export function triggerWorkers(): void {
  if (queueState.status !== "running") return;
  const availableSlots = Math.max(0, queueState.concurrency - queueState.activeCount);
  for (let index = 0; index < availableSlots; index += 1) {
    void workerLoop();
  }
}
