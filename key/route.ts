import { NextResponse } from "next/server";
import { setApiKey, hasApiKey, clearApiKey } from "@/lib/apiKeyStore";

export async function GET() {
  return NextResponse.json({ hasKey: hasApiKey() });
}

export async function POST(req: Request) {
  try {
    const { apiKey } = await req.json();
    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return NextResponse.json({ error: "API Key cannot be empty." }, { status: 400 });
    }
    setApiKey(apiKey.trim());
    return NextResponse.json({ success: true, hasKey: true });
  } catch (err: any) {
    return NextResponse.json({ error: "Failed to parse request: " + err.message }, { status: 400 });
  }
}

export async function DELETE() {
  clearApiKey();
  return NextResponse.json({ success: true, hasKey: false });
}
