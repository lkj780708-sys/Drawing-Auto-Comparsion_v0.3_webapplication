import type { NextConfig } from "next";

// 창 1개 실행: `npm run build` 결과(out/)를 Python 서버가 그대로 제공한다 (Node 서버 불필요).
const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
};

export default nextConfig;
