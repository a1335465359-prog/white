import { NextResponse } from "next/server";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { queueState } from "@/lib/taskQueue";
import fs from "fs";
import path from "path";

export async function POST() {
  try {
    // Stop the queue
    queueState.status = "idle";
    queueState.activeCount = 0;

    // Delete tasks from database
    await db.delete(tasks);

    // Clean up filesystem directories
    const uploadsDir = path.join(process.cwd(), "storage", "uploads");
    const processedDir = path.join(process.cwd(), "storage", "processed");
    // Also clean old public/ directories for backward compatibility
    const oldUploadsDir = path.join(process.cwd(), "public", "uploads");
    const oldProcessedDir = path.join(process.cwd(), "public", "processed");

    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(uploadsDir, file));
        } catch (e) {
          console.error(`Failed to delete file ${file}:`, e);
        }
      }
    }

    if (fs.existsSync(processedDir)) {
      const files = fs.readdirSync(processedDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(processedDir, file));
        } catch (e) {
          console.error(`Failed to delete processed file ${file}:`, e);
        }
      }
    }

    // Also clean old public/ directories
    for (const dir of [oldUploadsDir, oldProcessedDir]) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          try {
            fs.unlinkSync(path.join(dir, file));
          } catch (e) {
            console.error(`Failed to delete old file ${file}:`, e);
          }
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to clear all tasks: " + err.message }, { status: 500 });
  }
}
