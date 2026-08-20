import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { ensureDirectories, queueState, triggerWorkers } from "@/lib/taskQueue";
import fs from "fs";
import path from "path";

export async function POST(req: Request) {
  try {
    ensureDirectories();
    const formData = await req.formData();
    const files = formData.getAll("files");

    if (!files || files.length === 0) {
      return NextResponse.json({ error: "No files uploaded." }, { status: 400 });
    }

    const insertedTasks = [];

    for (const item of files) {
      if (!(item instanceof File)) continue;

      const file = item as File;
      const originalName = file.name;
      const ext = path.extname(originalName).toLowerCase();

      // Check supported formats: JPG, JPEG, PNG, WEBP
      const allowedExts = [".jpg", ".jpeg", ".png", ".webp"];
      if (!allowedExts.includes(ext)) {
        // Skip unsupported files
        continue;
      }

      // Convert file stream to binary Buffer
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Create a unique filename on disk
      const sanitizedName = originalName.replace(/[^a-zA-Z0-9.-]/g, "_");
      const uniqueFilename = `${Date.now()}_${Math.floor(Math.random() * 100000)}_${sanitizedName}`;
      
      const relativePath = path.join("storage", "uploads", uniqueFilename);
      const absolutePath = path.join(process.cwd(), relativePath);

      // Write to storage/uploads/
      fs.writeFileSync(absolutePath, buffer);

      // Insert task row
      const [inserted] = await db
        .insert(tasks)
        .values({
          originalName,
          originalPath: relativePath,
          originalUrl: `/api/files/uploads/${uniqueFilename}`,
          status: "pending",
          retryCount: 0,
        })
        .returning();

      insertedTasks.push(inserted);
    }

    // 边传边处理：如果队列正在运行，新到的文件立即唤醒调度，
    // 客户端还在传后面的图，服务端已经开始处理先到的图。
    if (queueState.status === "running") {
      triggerWorkers();
    }

    return NextResponse.json({
      success: true,
      uploadedCount: insertedTasks.length,
      tasks: insertedTasks,
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to upload: " + err.message }, { status: 500 });
  }
}
