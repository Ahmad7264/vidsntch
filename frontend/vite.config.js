import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        home: path.resolve(root, "index.html"),
        youtube: path.resolve(root, "youtube-video-downloader/index.html"),
        instagram: path.resolve(root, "instagram-reel-downloader/index.html"),
        facebook: path.resolve(root, "facebook-video-downloader/index.html"),
        tiktok: path.resolve(root, "tiktok-video-downloader/index.html"),
        twitter: path.resolve(root, "twitter-video-downloader/index.html"),
        reddit: path.resolve(root, "reddit-video-downloader/index.html"),
        threads: path.resolve(root, "threads-video-downloader/index.html"),
        pinterest: path.resolve(root, "pinterest-video-downloader/index.html"),
        snapchat: path.resolve(root, "snapchat-video-downloader/index.html")
      }
    }
  }
});
