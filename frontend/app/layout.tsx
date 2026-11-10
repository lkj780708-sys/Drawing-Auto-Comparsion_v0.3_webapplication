import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Drawing Auto Comparison",
  description: "Old/New 도면 자동 비교 (engine v10)",
};

// 테마는 첫 화면이 깜박이지 않도록 렌더 전에 적용 (기본 다크)
const THEME_BOOT = `try{document.documentElement.dataset.theme=localStorage.getItem("dac.theme")==="light"?"light":"dark"}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
