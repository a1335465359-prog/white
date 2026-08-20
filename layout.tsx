import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "白底工坊 · 服装白底图批量精修",
  description: "批量上传服装图，一键生成专业纯白底电商商品图。",
  applicationName: "白底工坊",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "白底工坊",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f6fb",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
