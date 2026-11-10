declare module "next" {
  export interface Metadata { title?: string; description?: string }
  export interface NextConfig { output?: "export"; reactStrictMode?: boolean; poweredByHeader?: boolean; images?: { unoptimized?: boolean } }
}
declare const process: { env: Record<string, string | undefined> };
