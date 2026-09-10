import express from "express";
import cors from "cors";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import ffmpegStatic from "ffmpeg-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.disable("x-powered-by");

const INFO_TIMEOUT_MS = Math.min(
  Number(process.env.INFO_TIMEOUT_MS || 45000),
  120000,
);
const DOWNLOAD_TIMEOUT_MS = Math.min(
  Number(process.env.DOWNLOAD_TIMEOUT_MS || 240000),
  300000,
);
const MAX_ACTIVE_JOBS = Math.max(
  1,
  Number(process.env.MAX_ACTIVE_JOBS || 2),
);

const DOWNLOAD_DIR = path.join(os.tmpdir(), "vidsnatch");
const YTDLP_SOURCE =
  process.env.YTDLP_PATH ||
  path.join(
    __dirname,
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  );
let YTDLP_PATH = YTDLP_SOURCE;
let FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegStatic || "";

const infoCache = new Map();
const rateBuckets = new Map();
let activeDownloads = 0;

await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });

const PLATFORM_HOSTS = {
  instagram: ["instagram.com"],
  youtube: ["youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com"],
  facebook: ["facebook.com", "fb.watch", "m.facebook.com"],
  tiktok: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
  twitter: ["twitter.com", "x.com", "mobile.twitter.com"],
  reddit: ["reddit.com", "www.reddit.com", "old.reddit.com", "redd.it"],
  threads: ["threads.net"],
  pinterest: ["pinterest.com", "pin.it"],
  snapchat: ["snapchat.com"],
};

const allowedOrigins = new Set([
  "https://vidsnatch.fun",
  "https://www.vidsnatch.fun",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(process.env.CORS_ORIGIN || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
]);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
    exposedHeaders: [
      "Content-Disposition",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "X-VidSnatch-Filename",
    ],
  }),
);

app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});

function rateLimit(maxRequests) {
  return (req, res, next) => {
    const ip =
      String(req.headers["x-forwarded-for"] || req.ip || "unknown")
        .split(",")[0]
        .trim() || "unknown";
    const now = Date.now();
    const list = rateBuckets.get(ip) || [];
    const recent = list.filter((time) => now - time < 60_000);

    if (recent.length >= maxRequests) {
      const oldest = recent[0] || now;
      const retryAfter = Math.max(
        1,
        Math.ceil((60_000 - (now - oldest)) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Too many requests. Please try again in a moment.",
      });
    }

    recent.push(now);
    rateBuckets.set(ip, recent);
    next();
  };
}

function cleanHost(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "");
}

function hostMatches(host, allowed) {
  return host === allowed || host.endsWith(`.${allowed}`);
}

function detectPlatform(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;

    const host = cleanHost(parsed.hostname);

    for (const [platform, hosts] of Object.entries(PLATFORM_HOSTS)) {
      if (hosts.some((allowed) => hostMatches(host, allowed))) {
        return platform;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl).trim());
    const platform = detectPlatform(rawUrl);

    for (const parameter of [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "igsh",
      "igshid",
      "si",
    ]) {
      parsed.searchParams.delete(parameter);
    }

    parsed.hash = "";

    if (platform === "youtube") {
      const host = cleanHost(parsed.hostname);

      if (host === "youtu.be") {
        const id = parsed.pathname.replace(/^\/+/, "").split("/")[0];
        if (id) return `https://youtu.be/${id}`;
      }

      const id = parsed.searchParams.get("v");
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }

    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(rawUrl || "").trim();
  }
}

function formatLabel(format) {
  const height = format.height ? `${format.height}p` : "";
  const fps =
    format.fps && Number(format.fps) > 30 ? `${format.fps}fps` : "";
  const ext = format.ext ? String(format.ext).toUpperCase() : "";
  const note = format.format_note || "";
  const sizeBytes = format.filesize || format.filesize_approx || 0;
  const size = sizeBytes
    ? `~${(sizeBytes / 1048576).toFixed(1)} MB`
    : "";
  return [height, fps, note, ext, size].filter(Boolean).join(" · ");
}

function normalizeInfo(raw, platform) {
  const formats = raw.formats || [];

  if (platform !== "youtube") {
    const best = formats
      .filter(
        (format) =>
          format.vcodec &&
          format.vcodec !== "none" &&
          format.acodec &&
          format.acodec !== "none",
      )
      .sort(
        (a, b) => Number(b.height || 0) - Number(a.height || 0),
      )[0];

    return {
      platform,
      title: raw.title || raw.description || `${platform} Video`,
      uploader: raw.uploader || raw.channel || "",
      duration: raw.duration ?? null,
      viewCount: raw.view_count ?? null,
      thumbnail: raw.thumbnail || "",
      resolution: best?.height ? `${best.height}p` : "Available",
      videoUrl: best?.url || raw.url || "",
      formats: [],
      audioFormatId: null,
      supportsAudio: true,
    };
  }

  const byHeight = new Map();

  for (const format of formats) {
    if (
      !format.vcodec ||
      format.vcodec === "none" ||
      !format.height
    ) {
      continue;
    }

    const height = Number(format.height);
    if (!Number.isFinite(height) || height > 2160) continue;

    // Keep up to 4K UHD (2160p).

    const key = String(height);
    const previous = byHeight.get(key);

    // Prefer the highest-bitrate video stream at each resolution. This can
    // be a video-only DASH stream; the download path merges best audio with
    // it through FFmpeg.
    if (!previous || Number(format.tbr || 0) > Number(previous.tbr || 0)) {
      byHeight.set(key, format);
    }
  }

  const videoFormats = [...byHeight.values()].sort(
    (a, b) => Number(b.height || 0) - Number(a.height || 0),
  );

  const audio = formats
    .filter(
      (format) =>
        format.acodec &&
        format.acodec !== "none" &&
        (!format.vcodec || format.vcodec === "none"),
    )
    .sort((a, b) => Number(b.abr || 0) - Number(a.abr || 0))[0];

  return {
    platform: "youtube",
    title: raw.title || "YouTube Video",
    uploader: raw.uploader || raw.channel || "",
    duration: raw.duration ?? null,
    viewCount: raw.view_count ?? null,
    thumbnail: raw.thumbnail || "",
    resolution: videoFormats[0]?.height
      ? `${videoFormats[0].height}p`
      : "Available",
    formats: videoFormats.map((format) => ({
      formatId: String(format.format_id),
      resolution: `${format.height}p`,
      label: formatLabel(format),
      isMuxed: Boolean(format.acodec && format.acodec !== "none"),
    })),
    audioFormatId: audio?.format_id || "bestaudio",
    supportsAudio: true,
  };
}

function cleanError(error) {
  const text = String(error || "")
    .replace(/\s+/g, " ")
    .trim();

  if (/sign in to confirm|not a bot|confirm you.?re not a bot/i.test(text)) {
    return "The platform is temporarily blocking this request. Please try again later.";
  }

  if (/private|members.only|login required|not available/i.test(text)) {
    return "This media is private or unavailable for public downloading.";
  }

  if (/unsupported url/i.test(text)) {
    return "This URL is not supported.";
  }

  if (/ffmpeg.*not found|ffmpeg.*missing/i.test(text)) {
    return "This download format needs FFmpeg, which is not available in the Vercel runtime.";
  }

  return text.slice(-800) || "Something went wrong.";
}

function ytBaseArgs(platform, mode = "info") {
  const args = [
    "--no-warnings",
    "--no-playlist",
    "--socket-timeout",
    String(mode === "info" ? 30 : 15),
    "--extractor-retries",
    "3",
    "--retries",
    "3",
  ];

  if (FFMPEG_PATH) {
    args.push("--ffmpeg-location", FFMPEG_PATH);
  }

  if (platform === "youtube") {
    const potRoot = path.join(__dirname, "pot-provider");
    const potPluginDir = path.join(potRoot, "plugin");
    const potServerHome = path.join(potRoot, "server");

    args.push(
      "--js-runtimes",
      "node",
      "--remote-components",
      process.env.YTDLP_EJS_REMOTE_COMPONENTS || "ejs:github",
    );

    if (fs.existsSync(potPluginDir) && fs.existsSync(potServerHome)) {
      args.push(
        "--plugin-dirs",
        potPluginDir,
        "--extractor-args",
        `youtubepot-bgutilscript:server_home=${potServerHome}`,
        "--extractor-args",
        `youtube:player-client=${process.env.YOUTUBE_PLAYER_CLIENT || "mweb"}`,
      );
    }

    // Optional authenticated YouTube cookies. Keep the secret in a Vercel
    // Environment Variable; never commit cookies.txt to GitHub. Support both
    // plain Netscape-format cookies and base64-encoded cookies so multiline
    // cookie exports are easy to configure in Vercel.
    const cookieText = process.env.YOUTUBE_COOKIES?.trim();
    const cookieBase64 = process.env.YOUTUBE_COOKIES_B64?.trim();
    if (cookieText || cookieBase64) {
      const cookiePath = path.join(
        os.tmpdir(),
        "vidsnatch",
        "youtube-cookies.txt",
      );
      fs.mkdirSync(path.dirname(cookiePath), { recursive: true });

      let contents = cookieText || "";
      if (!contents && cookieBase64) {
        contents = Buffer.from(cookieBase64, "base64").toString("utf8");
      }

      if (!contents.includes("# Netscape HTTP Cookie File")) {
        console.warn(
          "[youtube] YOUTUBE_COOKIES does not look like a Netscape cookie export.",
        );
      }

      fs.writeFileSync(cookiePath, contents, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        fs.chmodSync(cookiePath, 0o600);
      } catch {}
      args.push("--cookies", cookiePath);
    }
  }

  return args;
}

async function ensureYtDlp() {
  try {
    const sourceStat = await fsp.stat(YTDLP_SOURCE);
    if (!sourceStat.isFile() || sourceStat.size < 1_000_000) {
      throw new Error("Bundled yt-dlp binary is invalid.");
    }

    if (process.platform !== "win32") {
      // Vercel function files are read-only. Copy the bundled executable to
      // /tmp, which is writable, then execute the writable copy.
      const runtimePath = path.join(os.tmpdir(), "vidsnatch", "yt-dlp");
      const runtimeStat = await fsp.stat(runtimePath).catch(() => null);

      if (!runtimeStat || runtimeStat.size !== sourceStat.size) {
        await fsp.mkdir(path.dirname(runtimePath), { recursive: true });
        await fsp.copyFile(YTDLP_SOURCE, runtimePath);
      }

      await fsp.chmod(runtimePath, 0o755);
      YTDLP_PATH = runtimePath;
    } else {
      YTDLP_PATH = YTDLP_SOURCE;
    }
  } catch (error) {
    console.error("[yt-dlp bootstrap]", error);
    throw new Error(
      `yt-dlp is not available in this Vercel deployment: ${error?.message || error}`,
    );
  }
}

async function getInfo(url, platform) {
  await ensureYtDlp();

  const args = [
    ...ytBaseArgs(platform, "info"),
    "--dump-single-json",
    "--skip-download",
    "--no-check-certificates",
  ];

  if (platform !== "youtube") {
    args.push("-f", "best");
  }

  args.push("--", url);

  const { stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args, {
      cwd: DOWNLOAD_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error("Metadata request timed out."));
      }
    }, INFO_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 50 * 1024 * 1024) {
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0) {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

  if (!stdout.trim()) {
    throw new Error(stderr || "No media information returned.");
  }

  return normalizeInfo(JSON.parse(stdout.trim()), platform);
}

async function runDownload(params) {
  await ensureYtDlp();

  if (activeDownloads >= MAX_ACTIVE_JOBS) {
    const error = new Error(
      "Downloader is currently busy. Please try again in a moment.",
    );
    error.statusCode = 429;
    throw error;
  }

  activeDownloads += 1;

  const id = crypto.randomUUID().replaceAll("-", "");
  const prefix = `download-${id}`;
  const output = path.join(DOWNLOAD_DIR, `${prefix}.%(ext)s`);

  const isAudio = params.mediaType === "audio";

  try {
    if (params.platform === "instagram" && isAudio) {
      const error = new Error("Instagram downloads are video-only.");
      error.statusCode = 400;
      throw error;
    }

    const args = [
      ...ytBaseArgs(params.platform, "download"),
      "--newline",
      "--no-part",
      "--retries",
      "3",
      "--fragment-retries",
      "3",
      "--file-access-retries",
      "2",
      "-o",
      output,
    ];

    if (isAudio) {
      // Keep the original best audio container; FFmpeg is available for
      // video/audio merging, but audio conversion is intentionally unchanged.
      args.push(
        "-f",
        "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
      );
    } else if (params.platform === "youtube" && params.formatId) {
      const formatId = String(params.formatId).replace(/[^\w.+-]/g, "");
      // The frontend sends either a muxed format ID or video+audio IDs
      // joined with '+'. FFmpeg merges separate YouTube streams into MP4.
      args.push("-f", formatId);
      args.push("--merge-output-format", "mp4/mkv");
    } else if (params.platform === "youtube") {
      args.push("-f", "bestvideo*+bestaudio/best");
      args.push("--merge-output-format", "mp4/mkv");
    } else {
      args.push(
        "-f",
        "best[vcodec!=none][acodec!=none]/best",
      );
    }

    args.push("--", params.url);

    await new Promise((resolve, reject) => {
      const child = spawn(YTDLP_PATH, args, {
        cwd: DOWNLOAD_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
        if (!settled) {
          settled = true;
          reject(new Error("Download timed out. Please try again."));
        }
      }, DOWNLOAD_TIMEOUT_MS);

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 20 * 1024 * 1024) {
          stderr = stderr.slice(-20 * 1024 * 1024);
        }
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;

        if (code !== 0) {
          reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        } else {
          resolve();
        }
      });
    });

    const entries = await fsp.readdir(DOWNLOAD_DIR);
    const candidates = [];

    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      if (name.endsWith(".part") || name.endsWith(".ytdl")) continue;

      const fullPath = path.join(DOWNLOAD_DIR, name);
      try {
        const stat = await fsp.stat(fullPath);
        if (stat.isFile() && stat.size > 0) {
          candidates.push({ path: fullPath, size: stat.size });
        }
      } catch {}
    }

    candidates.sort((a, b) => b.size - a.size);
    const file = candidates[0];

    if (!file) throw new Error("Downloaded file was not found.");

    const extension =
      path.extname(file.path).replace(".", "").toLowerCase() || "mp4";

    const safeTitle =
      String(params.videoTitle || params.platform || "VidSnatch")
        .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 100) || "VidSnatch";

    const filename = `VidSnatch_${safeTitle}.${extension}`;

    return {
      path: file.path,
      size: file.size,
      filename,
      extension,
    };
  } catch (error) {
    await cleanupPrefix(prefix);
    throw error;
  } finally {
    activeDownloads = Math.max(0, activeDownloads - 1);
  }
}

async function cleanupPrefix(prefix) {
  const entries = await fsp.readdir(DOWNLOAD_DIR).catch(() => []);

  await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix))
      .map((name) =>
        fsp
          .rm(path.join(DOWNLOAD_DIR, name), { force: true })
          .catch(() => {}),
      ),
  );
}

function contentTypeFor(extension) {
  const map = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    opus: "audio/ogg",
    ogg: "audio/ogg",
    wav: "audio/wav",
  };
  return map[extension] || "application/octet-stream";
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "vidsnatch-vercel-api",
    ytDlpReady: fs.existsSync(YTDLP_PATH),
    ffmpegReady: Boolean(FFMPEG_PATH),
    youtubePotProviderReady:
      fs.existsSync(path.join(__dirname, "pot-provider", "plugin")) &&
      fs.existsSync(path.join(__dirname, "pot-provider", "server", "build", "generate_once.js")),
    youtubeCookiesConfigured: Boolean(
      process.env.YOUTUBE_COOKIES?.trim() ||
        process.env.YOUTUBE_COOKIES_B64?.trim(),
    ),
    activeDownloads,
    time: new Date().toISOString(),
  });
});

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "vidsnatch-vercel-api",
    ytDlpReady: fs.existsSync(YTDLP_PATH),
    ffmpegReady: Boolean(FFMPEG_PATH),
    youtubePotProviderReady:
      fs.existsSync(path.join(__dirname, "pot-provider", "plugin")) &&
      fs.existsSync(path.join(__dirname, "pot-provider", "server", "build", "generate_once.js")),
    youtubeCookiesConfigured: Boolean(
      process.env.YOUTUBE_COOKIES?.trim() ||
        process.env.YOUTUBE_COOKIES_B64?.trim(),
    ),
    time: new Date().toISOString(),
  });
});

app.post("/api/info", rateLimit(30), async (req, res) => {
  const rawUrl = req.body?.url;

  if (!rawUrl) {
    return res.status(400).json({ error: "Please enter a URL." });
  }

  const platform = detectPlatform(rawUrl);

  if (!platform) {
    return res
      .status(400)
      .json({ error: "This platform is not supported yet." });
  }

  const normalized = normalizeUrl(rawUrl);
  const cacheKey = `${platform}:${normalized}`;
  const cached = infoCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.data);
  }

  try {
    const data = await getInfo(normalized, platform);

    infoCache.set(cacheKey, {
      data,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });

    if (infoCache.size > 100) {
      const oldest = infoCache.keys().next().value;
      if (oldest) infoCache.delete(oldest);
    }

    return res.json(data);
  } catch (error) {
    console.error("[api/info]", error);
    return res.status(500).json({
      error: cleanError(error?.stderr || error?.message),
    });
  }
});

app.post("/api/download", rateLimit(10), async (req, res) => {
  const {
    url,
    platform,
    type,
    mediaType,
    formatId,
    videoTitle,
  } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: "Please enter a URL." });
  }

  const detected = detectPlatform(url);

  if (!detected) {
    return res
      .status(400)
      .json({ error: "This platform is not supported yet." });
  }

  const requestedPlatform = platform || type || detected;

  if (requestedPlatform !== detected) {
    return res
      .status(400)
      .json({ error: "The selected platform does not match the URL." });
  }

  if (!["video", "audio"].includes(mediaType)) {
    return res.status(400).json({ error: "Invalid media type." });
  }

  if (detected === "instagram" && mediaType === "audio") {
    return res
      .status(400)
      .json({ error: "Instagram downloads are video-only." });
  }

  let result;

  try {
    result = await runDownload({
      url: normalizeUrl(url),
      platform: detected,
      mediaType,
      formatId,
      videoTitle,
    });

    const stat = await fsp.stat(result.path);

    res.status(200);
    res.setHeader("Content-Type", contentTypeFor(result.extension));
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Cache-Control", "no-store");
    // Node's ServerResponse rejects non-Latin-1 characters in raw header values.
    // Keep an ASCII-safe fallback filename and put the real Unicode filename in
    // the RFC 5987 filename* parameter. This prevents ERR_INVALID_CHAR for
    // Hindi, emoji, accented, CJK, and other Unicode video titles.
    const asciiFallback =
      result.filename
        .replace(/[\r\n]/g, "_")
        .replace(/[^\x20-\x7E]/g, "_")
        .replace(/["\\]/g, "_")
        .trim() || "VidSnatch_download.mp4";

    const encodedFilename = encodeURIComponent(result.filename).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );

    res.setHeader("X-VidSnatch-Filename", encodedFilename);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`,
    );

    const stream = fs.createReadStream(result.path);

    stream.on("error", async (error) => {
      console.error("[api/download stream]", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Could not read downloaded file." });
      } else {
        res.destroy(error);
      }
      await fsp.rm(result.path, { force: true }).catch(() => {});
    });

    res.on("close", () => {
      fsp.rm(result.path, { force: true }).catch(() => {});
    });

    stream.pipe(res);
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    console.error("[api/download]", error);
    return res.status(status).json({
      error: cleanError(error?.stderr || error?.message),
    });
  }
});

export default app;
