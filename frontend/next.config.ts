import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The frontend is a private, gated tool — no SEO surface. It owns the UI + the
  // deterministic render routes (Playwright PDF + docx); all AI/data/auth is the FastAPI backend.
};

export default nextConfig;
