import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    // This repo may sit below an unrelated parent lockfile on developer machines.
    // Pin the app root so local, CI, and Docker builds resolve only this frontend.
    root: process.cwd(),
  },
  // The frontend is a private, gated tool — no SEO surface. It owns the UI + the
  // deterministic render routes (Playwright PDF + docx); all AI/data/auth is the FastAPI backend.
};

export default nextConfig;
