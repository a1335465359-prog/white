import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Serves files from the storage directory via API.
 * Also falls back to public/ for backward compatibility.
 *
 * URL format: /api/files/uploads/filename.jpg
 *             /api/files/processed/filename_white.jpg
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: urlSegments } = await params;

    if (!urlSegments || urlSegments.length === 0) {
      return NextResponse.json({ error: "No file path provided" }, { status: 400 });
    }

    const relativePath = urlSegments.join("/");

    // Security: Only allow uploads/ and processed/ subdirectories
    const allowedPrefixes = ["uploads/", "processed/"];
    if (!allowedPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
      return NextResponse.json({ error: "Invalid file path" }, { status: 403 });
    }

    // Primary location: storage/
    const storageDir = path.join(process.cwd(), "storage");
    const absolutePath = path.join(storageDir, relativePath);

    // Prevent directory traversal
    if (!absolutePath.startsWith(storageDir)) {
      return NextResponse.json({ error: "Invalid file path" }, { status: 403 });
    }

    let filePath = absolutePath;

    // Check storage/ first, then fallback to public/
    if (!fs.existsSync(absolutePath)) {
      const publicFallback = path.join(process.cwd(), "public", relativePath);
      if (fs.existsSync(publicFallback)) {
        filePath = publicFallback;
      } else {
        return NextResponse.json({ error: "File not found" }, { status: 404 });
      }
    }

    const fileBuffer = fs.readFileSync(filePath);
    const contentType = getMimeType(filePath);

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err: any) {
    console.error("File serving error:", err);
    return NextResponse.json(
      { error: "Failed to serve file: " + err.message },
      { status: 500 }
    );
  }
}
