"use client";

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import JSZip from "jszip";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Layers3,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
} from "lucide-react";
import { DEFAULT_WHITE_PROMPT } from "@/lib/prompts";

// ─── Types ────────────────────────────────────────────────────────────────────
type DetailType = "collar" | "cuff" | "pocket" | "hem";

const DETAIL_OPTIONS: { type: DetailType; label: string; emoji: string }[] = [
  { type: "collar", label: "领口", emoji: "🔲" },
  { type: "cuff",   label: "袖口", emoji: "🔷" },
  { type: "pocket", label: "口袋", emoji: "🟦" },
  { type: "hem",    label: "下摆", emoji: "📐" },
];

interface DetailTask {
  id: number;
  taskId: number;
  detailType: DetailType;
  sourcePath: string;
  resultPath: string | null;
  resultUrl: string | null;
  status: "pending" | "processing" | "success" | "failed";
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Task {
  id: number;
  originalName: string;
  originalPath: string;
  originalUrl: string;
  processedPath: string | null;
  processedUrl: string | null;
  status: "pending" | "processing" | "success" | "failed";
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  details: DetailTask[];
}

interface Stats {
  pending: number;
  processing: number;
  success: number;
  failed: number;
  total: number;
}

interface QueueState {
  status: "idle" | "running" | "paused";
  concurrency: number;
  activeCount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cx(...args: (string | false | null | undefined)[]): string {
  return args.filter(Boolean).join(" ");
}

const UPLOAD_CONCURRENCY = 6;
const MAX_EDGE = 2048;

async function compressImage(file: File): Promise<{ blob: Blob; name: string }> {
  const isPng = file.type === "image/png";
  if (isPng && file.size <= 1.5 * 1024 * 1024) return { blob: file, name: file.name };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && file.size <= 1.5 * 1024 * 1024) { bmp.close(); return { blob: file, name: file.name }; }
    const cvs = document.createElement("canvas");
    cvs.width  = Math.max(1, Math.round(bmp.width * scale));
    cvs.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = cvs.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, cvs.width, cvs.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((res) => cvs.toBlob(res, "image/jpeg", 0.85));
    if (!blob) return { blob: file, name: file.name };
    const name = /\.(jpe?g)$/i.test(file.name) ? file.name : file.name.replace(/\.[^/.]+$/, "") + ".jpg";
    return { blob, name };
  } catch {
    return { blob: file, name: file.name };
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function App() {
  // API key
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [isKeySaved, setIsKeySaved] = useState(false);
  const [keySaving, setKeySaving] = useState(false);

  // settings
  const [prompt, setPrompt] = useState(DEFAULT_WHITE_PROMPT);
  const [concurrency, setConcurrency] = useState(5);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // tasks & queue
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<Stats>({ pending: 0, processing: 0, success: 0, failed: 0, total: 0 });
  const [detailStats, setDetailStats] = useState<Stats>({ pending: 0, processing: 0, success: 0, failed: 0, total: 0 });
  const [queue, setQueue] = useState<QueueState>({ status: "idle", concurrency: 5, activeCount: 0 });

  // upload
  const [upProg, setUpProg] = useState({ total: 0, done: 0, failed: 0, active: false });
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileQueue = useRef<File[]>([]);
  const inFlight  = useRef(0);
  const isUploading = upProg.active;

  // selection
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // detail sheet
  const [detailSheetOpen, setDetailSheetOpen] = useState(false);
  const [detailTypes, setDetailTypes] = useState<DetailType[]>([]);

  // viewer
  const [viewerId, setViewerId]     = useState<number | null>(null);
  const [viewerTab, setViewerTab]   = useState<"main" | DetailType>("main");
  const viewerOpen = viewerId !== null;

  // zip progress
  const [zipping, setZipping] = useState(false);
  const [zipPct, setZipPct]   = useState(0);

  // misc
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; key: number } | null>(null);
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastKey = useRef(0);

  const showToast = useCallback((msg: string) => {
    if (toastT.current) clearTimeout(toastT.current);
    toastKey.current += 1;
    setToast({ msg, key: toastKey.current });
    toastT.current = setTimeout(() => setToast(null), 2600);
  }, []);

  // ── Polling ──────────────────────────────────────────────────────────────
  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks");
      if (!res.ok) return;
      const d = await res.json();
      setTasks((d.tasks || []).map((t: Task) => ({ ...t, details: t.details ?? [] })));
      setStats(d.stats ?? { pending: 0, processing: 0, success: 0, failed: 0, total: 0 });
      setDetailStats(d.detailStats ?? { pending: 0, processing: 0, success: 0, failed: 0, total: 0 });
      setQueue(d.queue ?? { status: "idle", concurrency: 5, activeCount: 0 });
      if (typeof d.queue?.concurrency === "number") setConcurrency(d.queue.concurrency);
    } catch {}
  }, []);

  useEffect(() => {
    fetch("/api/key").then(r => r.json()).then(d => setIsKeySaved(!!d.hasKey)).catch(() => {});
    fetchTasks();
    const t = setInterval(fetchTasks, 1500);
    return () => { clearInterval(t); if (toastT.current) clearTimeout(toastT.current); };
  }, [fetchTasks]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const successTasks = useMemo(() => tasks.filter(t => t.status === "success"), [tasks]);
  const isRunning    = queue.status === "running";

  // viewer task – always derived from latest tasks
  const viewerTask = useMemo(() => tasks.find(t => t.id === viewerId) ?? null, [tasks, viewerId]);

  // ── Upload ────────────────────────────────────────────────────────────────
  const runWorker = useCallback(async (file: File) => {
    let failed = false;
    try {
      const { blob, name } = await compressImage(file);
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        try {
          const fd = new FormData();
          fd.append("files", new Blob([blob], { type: blob.type || "application/octet-stream" }), name);
          ok = (await fetch("/api/tasks/upload", { method: "POST", body: fd })).ok;
        } catch {}
        if (!ok) await new Promise(r => setTimeout(r, 700 * (i + 1)));
      }
      if (!ok) failed = true;
    } catch { failed = true; }
    finally {
      if (failed) setUpProg(s => ({ ...s, failed: s.failed + 1 }));
      inFlight.current -= 1;
      setUpProg(s => ({
        ...s,
        done: s.done + 1,
        active: fileQueue.current.length > 0 || inFlight.current > 0,
      }));
    }
  }, []);

  const drain = useCallback(() => {
    const pump = () => {
      while (inFlight.current < UPLOAD_CONCURRENCY && fileQueue.current.length > 0) {
        const f = fileQueue.current.shift()!;
        inFlight.current += 1;
        runWorker(f).finally(pump);
      }
    };
    pump();
  }, [runWorker]);

  const handleFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files).filter(
      f => ["image/jpeg", "image/png", "image/webp"].includes(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name)
    );
    if (!list.length) { showToast("请选择 JPG / PNG / WEBP 图片"); return; }
    fileQueue.current.push(...list);
    setUpProg(s => ({ ...s, total: s.total + list.length, active: true }));
    drain();
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [drain, showToast]);

  // ── Queue ─────────────────────────────────────────────────────────────────
  const startQueue = useCallback(async (force = false) => {
    if (!isKeySaved) { setSettingsOpen(true); showToast("请先配置 API Key"); return; }
    if (!force && stats.pending === 0 && stats.failed === 0 && stats.total === 0 && !upProg.active) {
      showToast("请先上传图片"); return;
    }
    setBusy(true);
    try {
      if (stats.failed > 0 && stats.pending === 0)
        await fetch("/api/tasks/retry-all", { method: "POST" });
      const res = await fetch("/api/queue/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, concurrency }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "启动失败");
      await fetchTasks();
      showToast("正在处理中…");
    } catch (e: any) { showToast(e.message || "启动失败"); }
    finally { setBusy(false); }
  }, [isKeySaved, stats, upProg.active, prompt, concurrency, fetchTasks, showToast]);

  const pauseQueue = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/queue/pause", { method: "POST" });
      await fetchTasks();
      showToast("已暂停，当前任务继续完成");
    } catch { showToast("暂停失败"); }
    finally { setBusy(false); }
  }, [fetchTasks, showToast]);

  // ── Task actions ──────────────────────────────────────────────────────────
  const deleteTask = async (id: number) => {
    try {
      await fetch("/api/tasks/delete-single", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: id }),
      });
      if (viewerId === id) setViewerId(null);
      setSelected(p => { const n = new Set(p); n.delete(id); return n; });
      await fetchTasks();
    } catch { showToast("删除失败"); }
  };

  const regenMain = async (id: number) => {
    setBusy(true);
    try {
      const res = await fetch("/api/tasks/regenerate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: id }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "失败");
      if (!isRunning) await startQueue(true); else await fetchTasks();
      showToast("已重新加入队列");
    } catch (e: any) { showToast(e.message || "失败"); }
    finally { setBusy(false); }
  };

  const regenDetail = async (taskId: number, type: DetailType) => {
    setBusy(true);
    try {
      const res = await fetch("/api/details/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: [taskId], detailTypes: [type] }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "失败");
      if (!isRunning) await startQueue(true); else await fetchTasks();
      showToast("细节图已重新生成");
    } catch (e: any) { showToast(e.message || "失败"); }
    finally { setBusy(false); }
  };

  const batchGenDetails = async () => {
    if (!selected.size || !detailTypes.length) { showToast("请选择商品和部位"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/details/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: [...selected], detailTypes }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "失败");
      setDetailSheetOpen(false);
      setSelectMode(false);
      setSelected(new Set());
      setDetailTypes([]);
      if (!isRunning) await startQueue(true); else await fetchTasks();
      showToast(`已排队 ${d.count} 张细节图`);
    } catch (e: any) { showToast(e.message || "失败"); }
    finally { setBusy(false); }
  };

  // ── Download ──────────────────────────────────────────────────────────────
  const dlFile = useCallback(async (url: string | null, filename: string) => {
    if (!url) return;
    try {
      const blob = await fetch(url).then(r => r.blob());
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(blob), download: filename,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    } catch { showToast("下载失败"); }
  }, [showToast]);

  const downloadZip = async () => {
    const items: { url: string; path: string }[] = [];
    for (const t of successTasks) {
      if (t.processedUrl) {
        const ext = t.processedUrl.split(".").pop() || "jpg";
        items.push({ url: t.processedUrl, path: `主图/${t.originalName.replace(/\.[^/.]+$/, "")}_white.${ext}` });
      }
      for (const d of t.details) {
        if (d.status === "success" && d.resultUrl) {
          const ext = d.resultUrl.split(".").pop() || "jpg";
          const label = DETAIL_OPTIONS.find(o => o.type === d.detailType)?.label ?? d.detailType;
          items.push({ url: d.resultUrl, path: `细节/${t.originalName.replace(/\.[^/.]+$/, "")}_${label}.${ext}` });
        }
      }
    }
    if (!items.length) { showToast("暂无可下载的结果"); return; }
    setZipping(true); setZipPct(0);
    try {
      const zip = new JSZip();
      for (let i = 0; i < items.length; i++) {
        const res = await fetch(items[i].url);
        if (res.ok) zip.file(items[i].path, await res.blob());
        setZipPct(Math.round(((i + 1) / items.length) * 100));
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(blob),
        download: `白底图_${new Date().toISOString().slice(0, 10)}.zip`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      showToast(`已打包 ${items.length} 张图片`);
    } catch { showToast("打包失败"); }
    finally { setZipping(false); setZipPct(0); }
  };

  // ── Viewer navigation ─────────────────────────────────────────────────────
  const goNextViewer = () => {
    const idx = successTasks.findIndex(t => t.id === viewerId);
    const next = successTasks[idx + 1];
    if (next) { setViewerId(next.id); setViewerTab("main"); }
  };
  const goPrevViewer = () => {
    const idx = successTasks.findIndex(t => t.id === viewerId);
    const prev = successTasks[idx - 1];
    if (prev) { setViewerId(prev.id); setViewerTab("main"); }
  };

  // swipe on viewer
  const swipeX = useRef(0);
  const onVTouchStart = (e: React.TouchEvent) => { swipeX.current = e.changedTouches[0].clientX; };
  const onVTouchEnd   = (e: React.TouchEvent) => {
    const dx = swipeX.current - e.changedTouches[0].clientX;
    if (Math.abs(dx) > 44) { if (dx > 0) goNextViewer(); else goPrevViewer(); }
  };

  // viewer current image url
  const viewerImgUrl = useMemo(() => {
    if (!viewerTask) return null;
    if (viewerTab === "main") return viewerTask.processedUrl ?? viewerTask.originalUrl;
    const det = viewerTask.details.find(d => d.detailType === viewerTab);
    return det?.status === "success" ? (det.resultUrl ?? null) : null;
  }, [viewerTask, viewerTab]);

  // current viewer detail
  const viewerDetail = useMemo(() => {
    if (!viewerTask || viewerTab === "main") return null;
    return viewerTask.details.find(d => d.detailType === viewerTab) ?? null;
  }, [viewerTask, viewerTab]);

  const viewerIdx = successTasks.findIndex(t => t.id === viewerId);

  // ── Key ───────────────────────────────────────────────────────────────────
  const saveKey = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!apiKey.trim()) { showToast("请输入 API Key"); return; }
    setKeySaving(true);
    try {
      const res = await fetch("/api/key", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "保存失败");
      setIsKeySaved(true);
      setApiKey("");        // clear field immediately after save
      showToast("API Key 已保存");
    } catch (e: any) { showToast(e.message); }
    finally { setKeySaving(false); }
  };

  const clearKey = async () => {
    try {
      await fetch("/api/key", { method: "DELETE" });
      setIsKeySaved(false);
      showToast("Key 已清除，请重新配置");
    } catch { showToast("清除失败"); }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  const showEmpty = stats.total === 0 && !isUploading;

  return (
    <>
      {/* ── Global layout ─────────────────────────────────────────────────── */}
      <div className="min-h-screen flex flex-col bg-[#f7f8fa]">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header className="sticky top-0 z-30 flex items-center justify-between
                           px-4 h-14 bg-white/85 backdrop-blur-xl border-b border-black/[0.06]">
          {/* left: status */}
          <div className="flex items-center gap-2.5">
            <span className={cx(
              "w-2 h-2 rounded-full shrink-0",
              isRunning         ? "bg-emerald-500 animate-pulse"
              : queue.status === "paused" ? "bg-amber-400"
              : isUploading     ? "bg-blue-500 animate-pulse"
              : "bg-slate-300"
            )} />
            <span className="text-sm font-semibold text-slate-700">
              {isRunning
                ? `处理中 ${stats.processing} 张`
                : queue.status === "paused"
                ? "已暂停"
                : isUploading
                ? `上传 ${upProg.done}/${upProg.total}`
                : stats.total > 0
                ? `${stats.success} / ${stats.total} 完成`
                : "服装白底图"}
            </span>
          </div>

          {/* right: key status + settings */}
          <div className="flex items-center gap-2">
            {!isKeySaved && (
              <button
                onClick={() => setSettingsOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full
                           bg-amber-50 text-amber-600 text-xs font-semibold
                           border border-amber-200"
              >
                配置 Key
              </button>
            )}
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-9 h-9 rounded-full flex items-center justify-center
                         bg-slate-100 text-slate-600 active:bg-slate-200"
            >
              <Settings2 className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* ── Main scroll area ────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 py-4 space-y-4">

            {/* ─ Upload bar ─────────────────────────────────────────────── */}
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
              onClick={() => !isUploading && fileInputRef.current?.click()}
              className={cx(
                "relative flex items-center justify-center gap-3 rounded-2xl",
                "border-2 border-dashed transition-all select-none cursor-pointer",
                "px-5 py-4",
                dragging
                  ? "border-indigo-400 bg-indigo-50"
                  : isUploading
                  ? "border-blue-300 bg-blue-50 cursor-default"
                  : "border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40 active:bg-indigo-50/70"
              )}
            >
              <input
                ref={fileInputRef}
                type="file" multiple
                accept="image/png,image/jpeg,image/jpg,image/webp"
                className="hidden"
                onChange={e => e.target.files && handleFiles(e.target.files)}
              />

              {isUploading ? (
                <>
                  <Loader2 className="w-5 h-5 text-blue-500 spin shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>正在上传 · 本地压缩中</span>
                      <span>{upProg.done}/{upProg.total}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all duration-300"
                        style={{ width: `${upProg.total ? (upProg.done / upProg.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    className="shrink-0 text-xs font-medium text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-xl"
                  >+ 继续添加</button>
                </>
              ) : (
                <>
                  <div className="w-9 h-9 rounded-xl bg-indigo-100 flex items-center justify-center shrink-0">
                    <Upload className="w-4 h-4 text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-800">上传服装图片</p>
                    <p className="text-xs text-slate-500 mt-0.5">JPG / PNG / WEBP · 支持约 200 张批量</p>
                  </div>
                  <Plus className="w-5 h-5 text-slate-400 shrink-0" />
                </>
              )}
            </div>

            {/* ─ Progress / action strip ────────────────────────────────── */}
            {stats.total > 0 && (
              <div className="bg-white rounded-2xl border border-slate-200/80 overflow-hidden">
                {/* progress bar */}
                <div className="h-1 bg-slate-100">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-emerald-500 transition-all duration-500"
                    style={{ width: `${stats.total ? ((stats.success + stats.failed) / stats.total) * 100 : 0}%` }}
                  />
                </div>

                <div className="flex items-center gap-0 divide-x divide-slate-100">
                  {/* counts */}
                  {[
                    { label: "等待", val: stats.pending,    color: "text-slate-500" },
                    { label: "处理", val: stats.processing, color: "text-indigo-600" },
                    { label: "完成", val: stats.success,    color: "text-emerald-600" },
                    { label: "失败", val: stats.failed,     color: "text-red-500" },
                  ].map(({ label, val, color }) => (
                    <div key={label} className="flex-1 py-3 text-center">
                      <div className={cx("text-base font-bold tabular-nums", color)}>{val}</div>
                      <div className="text-[10px] text-slate-400 mt-0.5">{label}</div>
                    </div>
                  ))}
                </div>

                {/* detail stats if any */}
                {detailStats.total > 0 && (
                  <div className="border-t border-slate-100 px-4 py-2.5 flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      <Layers3 className="w-3.5 h-3.5 text-indigo-400" />
                      细节图
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-emerald-600 font-semibold">{detailStats.success} 已完成</span>
                      {detailStats.pending + detailStats.processing > 0 && (
                        <span className="text-indigo-500 font-medium">
                          {detailStats.pending + detailStats.processing} 进行中
                        </span>
                      )}
                      {detailStats.failed > 0 && (
                        <span className="text-red-500 font-medium">{detailStats.failed} 失败</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ─ Primary actions ────────────────────────────────────────── */}
            <div className="flex gap-2.5">
              {isRunning ? (
                <button
                  onClick={pauseQueue}
                  disabled={busy}
                  className="flex-1 h-12 rounded-2xl bg-slate-900 text-white font-semibold text-sm
                             flex items-center justify-center gap-2 active:opacity-80"
                >
                  <Pause className="w-4 h-4" /> 暂停
                </button>
              ) : (
                <button
                  onClick={() => startQueue()}
                  disabled={busy || !isKeySaved}
                  className={cx(
                    "flex-1 h-12 rounded-2xl font-semibold text-sm",
                    "flex items-center justify-center gap-2 active:opacity-80",
                    isKeySaved
                      ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/25"
                      : "bg-slate-200 text-slate-400"
                  )}
                >
                  {busy
                    ? <Loader2 className="w-4 h-4 spin" />
                    : <Play className="w-4 h-4 fill-current" />
                  }
                  {queue.status === "paused" ? "继续处理" : "开始生成"}
                </button>
              )}

              <button
                onClick={downloadZip}
                disabled={stats.success === 0 || zipping}
                className={cx(
                  "h-12 px-5 rounded-2xl text-sm font-semibold flex items-center gap-2",
                  "border transition-colors",
                  stats.success > 0
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700 active:bg-emerald-100"
                    : "border-slate-200 bg-white text-slate-300"
                )}
              >
                {zipping
                  ? <><Loader2 className="w-4 h-4 spin" />{zipPct}%</>
                  : <><Download className="w-4 h-4" />保存全部</>
                }
              </button>
            </div>

            {/* ─ Batch selection toolbar ────────────────────────────────── */}
            {successTasks.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (selectMode) {
                      setSelectMode(false);
                      setSelected(new Set());
                    } else {
                      setSelectMode(true);
                      setSelected(new Set(successTasks.map(t => t.id)));
                    }
                  }}
                  className={cx(
                    "flex items-center gap-1.5 px-4 h-9 rounded-full text-sm font-medium transition-colors",
                    selectMode
                      ? "bg-indigo-600 text-white"
                      : "bg-white text-slate-600 border border-slate-200"
                  )}
                >
                  {selectMode ? `已选 ${selected.size} 件` : "批量选择"}
                </button>

                {selectMode && (
                  <>
                    <button
                      onClick={() => setSelected(new Set(successTasks.map(t => t.id)))}
                      className="px-3 h-9 rounded-full text-sm text-slate-500 bg-white border border-slate-200"
                    >全选</button>

                    {selected.size > 0 && (
                      <button
                        onClick={() => { setDetailTypes([]); setDetailSheetOpen(true); }}
                        className="ml-auto flex items-center gap-1.5 px-4 h-9 rounded-full
                                   bg-emerald-600 text-white text-sm font-semibold shadow-sm"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        生成细节图
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ─ Empty state ────────────────────────────────────────────── */}
            {showEmpty && (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <div className="w-16 h-16 rounded-3xl bg-slate-100 flex items-center justify-center">
                  <Upload className="w-7 h-7 text-slate-400" />
                </div>
                <div>
                  <p className="text-base font-semibold text-slate-700">上传服装原图</p>
                  <p className="mt-1 text-sm text-slate-400">支持批量上传，系统自动压缩和排队处理</p>
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-2 px-5 py-2.5 rounded-2xl bg-indigo-600 text-white text-sm font-semibold"
                >选择图片</button>
              </div>
            )}

            {/* ─ Photo grid ─────────────────────────────────────────────── */}
            {tasks.length > 0 && (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {tasks.map(task => {
                  const isSelected = selected.has(task.id);
                  const detailOK   = task.details.filter(d => d.status === "success").length;
                  const thumb      = task.status === "success" && task.processedUrl
                                     ? task.processedUrl
                                     : task.originalUrl;

                  return (
                    <div
                      key={task.id}
                      className={cx(
                        "relative rounded-2xl overflow-hidden bg-white border-2 transition-all",
                        "aspect-[3/4]",
                        isSelected            ? "border-indigo-500 shadow-md shadow-indigo-200"
                        : task.status === "failed" ? "border-red-200"
                        : "border-transparent"
                      )}
                      onClick={() => {
                        if (selectMode) {
                          // in selection mode, clicking any card toggles — but only success cards
                          if (task.status !== "success") return;
                          setSelected(prev => {
                            const n = new Set(prev);
                            if (n.has(task.id)) n.delete(task.id); else n.add(task.id);
                            return n;
                          });
                        } else {
                          // open viewer only for success tasks; others show inline controls
                          if (task.status === "success") {
                            setViewerId(task.id);
                            setViewerTab("main");
                          }
                        }
                      }}
                    >
                      {/* Image — contain, white bg */}
                      <div className="absolute inset-0 checker">
                        <img
                          src={thumb}
                          alt={task.originalName}
                          loading="lazy"
                          className="thumb-img"
                        />
                      </div>

                      {/* Dim non-success in select mode */}
                      {selectMode && task.status !== "success" && (
                        <div className="absolute inset-0 bg-white/60" />
                      )}

                      {/* Status badge (top-left) */}
                      <div className="absolute top-1.5 left-1.5">
                        {selectMode && task.status === "success" ? (
                          <div className={cx(
                            "w-6 h-6 rounded-full border-2 flex items-center justify-center",
                            isSelected
                              ? "bg-indigo-600 border-indigo-600"
                              : "bg-white/80 border-white"
                          )}>
                            {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                          </div>
                        ) : task.status === "processing" ? (
                          <div className="flex items-center gap-1 bg-indigo-600/90 text-white
                                          px-1.5 py-0.5 rounded-full">
                            <Loader2 className="w-2.5 h-2.5 spin" />
                            <span className="text-[10px] font-bold">处理中</span>
                          </div>
                        ) : task.status === "failed" ? (
                          <div className="bg-red-500/90 text-white px-1.5 py-0.5 rounded-full text-[10px] font-bold">
                            失败
                          </div>
                        ) : task.status === "pending" ? (
                          <div className="bg-black/50 text-white px-1.5 py-0.5 rounded-full text-[10px]">
                            等待
                          </div>
                        ) : null}
                      </div>

                      {/* Detail count badge (top-right) */}
                      {task.status === "success" && detailOK > 0 && !selectMode && (
                        <div className="absolute top-1.5 right-1.5 bg-black/60 text-white
                                        px-1.5 py-0.5 rounded-full text-[10px] font-semibold">
                          {detailOK} 细节
                        </div>
                      )}

                      {/* Bottom actions overlay — only in normal mode */}
                      {!selectMode && (
                        <div className="absolute bottom-0 inset-x-0 p-1.5 flex gap-1">
                          {task.status === "success" && (
                            <button
                              onClick={e => { e.stopPropagation(); dlFile(task.processedUrl, `${task.originalName.replace(/\.[^/.]+$/, "")}_white.jpg`); }}
                              className="flex-1 h-8 rounded-xl bg-black/50 backdrop-blur
                                         flex items-center justify-center active:bg-black/70"
                              title="下载主图"
                            >
                              <Download className="w-3.5 h-3.5 text-white" />
                            </button>
                          )}
                          {task.status === "failed" && (
                            <button
                              onClick={e => { e.stopPropagation(); regenMain(task.id); }}
                              className="flex-1 h-8 rounded-xl bg-amber-500/80 backdrop-blur
                                         flex items-center justify-center active:opacity-80"
                              title="重试"
                            >
                              <RefreshCw className="w-3.5 h-3.5 text-white" />
                            </button>
                          )}
                          {task.status === "pending" || task.status === "processing" ? (
                            <div className="flex-1 h-8 rounded-xl bg-black/20 flex items-center justify-center">
                              <span className="text-[10px] text-white/60">
                                {task.status === "pending" ? "排队中" : "处理中"}
                              </span>
                            </div>
                          ) : null}
                          <button
                            onClick={e => { e.stopPropagation(); deleteTask(task.id); }}
                            className="w-8 h-8 rounded-xl bg-black/50 backdrop-blur
                                       flex items-center justify-center active:bg-red-500/80"
                            title="删除"
                          >
                            <X className="w-3.5 h-3.5 text-white/80" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

          </div>{/* /content */}
        </main>
      </div>{/* /layout */}

      {/* ══════════════════════════════════════════════════════════════════════
          VIEWER (full-screen, swipeable)
         ══════════════════════════════════════════════════════════════════════ */}
      {viewerOpen && viewerTask && (
        <div
          className="fixed inset-0 z-50 bg-black flex flex-col"
          onTouchStart={onVTouchStart}
          onTouchEnd={onVTouchEnd}
        >
          {/* header */}
          <div className="shrink-0 flex items-center justify-between px-4 py-3 pt-safe">
            <button
              onClick={() => setViewerId(null)}
              className="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 active:bg-white/20"
            >
              <X className="w-5 h-5 text-white" />
            </button>

            <div className="text-center flex-1 mx-3">
              <p className="text-sm font-semibold text-white truncate leading-tight">
                {viewerTask.originalName}
              </p>
              {successTasks.length > 1 && (
                <p className="text-xs text-white/50 mt-0.5">
                  {viewerIdx + 1} / {successTasks.length}
                </p>
              )}
            </div>

            {/* right actions depending on tab */}
            <div className="flex gap-2">
              {viewerTab === "main" ? (
                <>
                  <button
                    onClick={() => regenMain(viewerTask.id)}
                    disabled={busy}
                    className="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 active:bg-white/20"
                    title="重新生成主图"
                  >
                    <RotateCcw className="w-4 h-4 text-white" />
                  </button>
                  <button
                    onClick={() => dlFile(viewerTask.processedUrl, `${viewerTask.originalName.replace(/\.[^/.]+$/, "")}_white.jpg`)}
                    className="w-9 h-9 flex items-center justify-center rounded-full bg-emerald-500/80 active:bg-emerald-500"
                    title="下载主图"
                  >
                    <Download className="w-4 h-4 text-white" />
                  </button>
                </>
              ) : (
                <>
                  {viewerDetail?.status === "success" && (
                    <>
                      <button
                        onClick={() => regenDetail(viewerTask.id, viewerTab as DetailType)}
                        disabled={busy}
                        className="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 active:bg-white/20"
                        title="重新生成此细节图"
                      >
                        <RotateCcw className="w-4 h-4 text-white" />
                      </button>
                      <button
                        onClick={() => {
                          const opt = DETAIL_OPTIONS.find(o => o.type === viewerTab);
                          dlFile(viewerDetail.resultUrl, `${viewerTask.originalName.replace(/\.[^/.]+$/, "")}_${opt?.label ?? viewerTab}.jpg`);
                        }}
                        className="w-9 h-9 flex items-center justify-center rounded-full bg-emerald-500/80 active:bg-emerald-500"
                        title="下载此细节图"
                      >
                        <Download className="w-4 h-4 text-white" />
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {/* image area */}
          <div className="flex-1 relative flex items-center justify-center px-4">
            {viewerTab === "main" ? (
              <>
                {viewerImgUrl && (
                  <img
                    key={`${viewerTask.id}-main`}
                    src={viewerImgUrl}
                    alt="白底主图"
                    className="max-w-full max-h-full object-contain rounded-2xl"
                  />
                )}
                {viewerTask.status === "processing" && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                    <Loader2 className="w-12 h-12 spin text-indigo-400" />
                    <p className="text-white/60 text-sm">生成白底主图中…</p>
                  </div>
                )}
              </>
            ) : (
              <>
                {viewerDetail?.status === "success" && viewerDetail.resultUrl && (
                  <img
                    key={`${viewerTask.id}-${viewerTab}`}
                    src={viewerDetail.resultUrl}
                    alt={`细节图-${viewerTab}`}
                    className="max-w-full max-h-full object-contain rounded-2xl"
                  />
                )}
                {(viewerDetail?.status === "processing" || viewerDetail?.status === "pending") && (
                  <div className="flex flex-col items-center gap-3">
                    <Loader2 className="w-10 h-10 spin text-indigo-400" />
                    <p className="text-white/60 text-sm">细节图生成中…</p>
                  </div>
                )}
                {viewerDetail?.status === "failed" && (
                  <div className="flex flex-col items-center gap-4">
                    <AlertCircle className="w-10 h-10 text-red-400" />
                    <p className="text-white/60 text-sm text-center px-6">生成失败，可重试</p>
                    <button
                      onClick={() => regenDetail(viewerTask.id, viewerTab as DetailType)}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-amber-500 text-white font-semibold text-sm"
                    >
                      <RotateCcw className="w-4 h-4" /> 重新生成
                    </button>
                  </div>
                )}
                {!viewerDetail && (
                  <div className="flex flex-col items-center gap-4">
                    <Layers3 className="w-10 h-10 text-white/30" />
                    <p className="text-white/50 text-sm">未生成此细节图</p>
                    <button
                      onClick={() => regenDetail(viewerTask.id, viewerTab as DetailType)}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-indigo-600 text-white font-semibold text-sm"
                    >
                      <Sparkles className="w-4 h-4" /> 立即生成
                    </button>
                  </div>
                )}
              </>
            )}

            {/* prev/next arrows (desktop) */}
            {viewerIdx > 0 && (
              <button
                onClick={goPrevViewer}
                className="hidden sm:flex absolute left-0 top-1/2 -translate-y-1/2
                           w-10 h-10 rounded-full bg-white/10 items-center justify-center
                           hover:bg-white/20 ml-1"
              >
                <ChevronLeft className="w-5 h-5 text-white" />
              </button>
            )}
            {viewerIdx < successTasks.length - 1 && (
              <button
                onClick={goNextViewer}
                className="hidden sm:flex absolute right-0 top-1/2 -translate-y-1/2
                           w-10 h-10 rounded-full bg-white/10 items-center justify-center
                           hover:bg-white/20 mr-1"
              >
                <ChevronRight className="w-5 h-5 text-white" />
              </button>
            )}
          </div>

          {/* bottom tabs — scrollable */}
          <div className="shrink-0 bg-neutral-900 border-t border-white/10 px-4 pt-3 pb-safe">
            <div className="tab-strip">
              <button
                onClick={() => setViewerTab("main")}
                className={cx(
                  "shrink-0 px-4 py-2 rounded-full text-sm font-semibold transition-colors",
                  viewerTab === "main"
                    ? "bg-white text-black"
                    : "bg-white/10 text-white/70 hover:bg-white/15"
                )}
              >
                主图
              </button>

              {DETAIL_OPTIONS.map(opt => {
                const det = viewerTask.details.find(d => d.detailType === opt.type);
                const isActive = viewerTab === opt.type;
                const isDone   = det?.status === "success";
                const isWorking = det?.status === "processing" || det?.status === "pending";
                const isFailed  = det?.status === "failed";

                return (
                  <button
                    key={opt.type}
                    onClick={() => setViewerTab(opt.type)}
                    className={cx(
                      "shrink-0 px-4 py-2 rounded-full text-sm font-semibold transition-colors flex items-center gap-1.5",
                      isActive ? "bg-indigo-600 text-white"
                      : isDone ? "bg-emerald-500/20 text-emerald-400"
                      : isFailed ? "bg-red-500/20 text-red-400"
                      : "bg-white/10 text-white/60"
                    )}
                  >
                    {opt.label}
                    {isWorking && <Loader2 className="w-3 h-3 spin" />}
                    {isDone && !isActive && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />}
                    {isFailed && !isActive && <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />}
                  </button>
                );
              })}
            </div>

            {/* delete this task from viewer */}
            <button
              onClick={() => deleteTask(viewerTask.id)}
              className="mt-3 w-full h-10 rounded-2xl bg-white/5 text-white/50
                         text-sm flex items-center justify-center gap-2 active:bg-red-500/20 active:text-red-400"
            >
              <Trash2 className="w-4 h-4" /> 删除此商品
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          DETAIL SHEET
         ══════════════════════════════════════════════════════════════════════ */}
      {detailSheetOpen && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDetailSheetOpen(false)} />
          <div className="relative w-full bg-white rounded-t-3xl px-5 pt-5 pb-safe">
            {/* handle */}
            <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-5" />

            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">生成细节图</h3>
                <p className="text-sm text-slate-500 mt-0.5">
                  已选 {selected.size} 件商品，选择要生成的部位
                </p>
              </div>
              <button onClick={() => setDetailSheetOpen(false)} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                <X className="w-4 h-4 text-slate-600" />
              </button>
            </div>

            {/* part selector */}
            <div className="grid grid-cols-4 gap-2 mb-5">
              {DETAIL_OPTIONS.map(opt => {
                const on = detailTypes.includes(opt.type);
                return (
                  <button
                    key={opt.type}
                    onClick={() => setDetailTypes(p => on ? p.filter(t => t !== opt.type) : [...p, opt.type])}
                    className={cx(
                      "flex flex-col items-center gap-1.5 py-3.5 rounded-2xl",
                      "text-sm font-semibold border-2 transition-all",
                      on
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                        : "border-slate-200 bg-white text-slate-600"
                    )}
                  >
                    <span className="text-xl">{opt.emoji}</span>
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {/* summary */}
            <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600 mb-4 text-center">
              将生成{" "}
              <span className="font-bold text-slate-900">
                {selected.size * detailTypes.length}
              </span>{" "}
              张细节图，自动并发处理
            </div>

            <button
              onClick={batchGenDetails}
              disabled={detailTypes.length === 0 || busy}
              className="w-full h-14 rounded-2xl bg-emerald-600 text-white font-bold text-base
                         flex items-center justify-center gap-2
                         disabled:bg-slate-200 disabled:text-slate-400"
            >
              {busy
                ? <Loader2 className="w-5 h-5 spin" />
                : <><Sparkles className="w-5 h-5" /> 确认生成</>
              }
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SETTINGS SHEET
         ══════════════════════════════════════════════════════════════════════ */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSettingsOpen(false)} />
          <div className="relative w-full bg-white rounded-t-3xl px-5 pt-5 pb-safe max-h-[85vh] overflow-y-auto">
            <div className="w-10 h-1 rounded-full bg-slate-200 mx-auto mb-5" />

            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-bold text-slate-900">设置</h3>
              <button onClick={() => setSettingsOpen(false)} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                <X className="w-4 h-4 text-slate-600" />
              </button>
            </div>

            {/* API Key */}
            <div className="mb-5">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">API Key</p>
              {isKeySaved ? (
                <div className="flex items-center justify-between p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-500" />
                    <span className="text-sm font-medium text-emerald-800">Key 已配置，仅在内存中保存</span>
                  </div>
                  <button onClick={clearKey} className="text-xs font-bold text-red-500 px-2 py-1">清除</button>
                </div>
              ) : (
                <form onSubmit={saveKey} className="space-y-2.5">
                  <div className="relative">
                    <input
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      onChange={e => setApiKey(e.target.value)}
                      placeholder="sk-..."
                      autoComplete="off"
                      className="w-full h-12 px-4 pr-12 rounded-2xl border border-slate-200
                                 bg-slate-50 text-sm outline-none focus:ring-2 focus:ring-indigo-500
                                 focus:bg-white transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                    >
                      {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <button
                    type="submit"
                    disabled={keySaving}
                    className="w-full h-12 rounded-2xl bg-indigo-600 text-white text-sm font-bold
                               flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {keySaving ? <Loader2 className="w-4 h-4 spin" /> : null}
                    保存 Key
                  </button>
                </form>
              )}
            </div>

            {/* Concurrency */}
            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">并发数</p>
                <span className="text-sm font-bold text-slate-800">{concurrency}</span>
              </div>
              <input
                type="range" min={1} max={20} value={concurrency}
                onChange={e => setConcurrency(Number(e.target.value))}
                className="w-full accent-indigo-600 h-2"
              />
              <p className="mt-2 text-xs text-slate-400">建议 3～8，过高容易被限流</p>
            </div>

            {/* Prompt */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">处理提示词</p>
                <button onClick={() => setPrompt(DEFAULT_WHITE_PROMPT)} className="text-xs text-indigo-600 font-medium">恢复默认</button>
              </div>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                rows={6}
                className="w-full px-3 py-3 rounded-2xl border border-slate-200 bg-slate-50
                           text-xs leading-relaxed outline-none focus:ring-2 focus:ring-indigo-500
                           focus:bg-white resize-none"
              />
            </div>
          </div>
        </div>
      )}

      {/* ══ Toast ══════════════════════════════════════════════════════════════ */}
      {toast && (
        <div
          key={toast.key}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[70]
                     px-5 py-2.5 rounded-full bg-slate-900 text-white text-sm
                     font-medium shadow-2xl toast-anim pointer-events-none"
        >
          {toast.msg}
        </div>
      )}
    </>
  );
}
