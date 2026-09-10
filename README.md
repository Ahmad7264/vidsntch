# VidSnatch — Vercel

VidSnatch is a Vite frontend with a Node.js API deployed as a Vercel Function.

## Deploy

1. Push this project to GitHub.
2. Import the repository into Vercel.
3. Keep the Vercel project Root Directory at the repository root.
4. Build Command: `npm run build`
5. Output Directory: `frontend/dist`
6. Framework Preset: Vite.
7. Deploy.

The API is served from the same domain under `/api/*`.

## Environment variables

Set only the variables required by your deployment:

- `CORS_ORIGIN=https://vidsnatch.fun,https://www.vidsnatch.fun`
- `YOUTUBE_COOKIES` (optional)
- `YTDLP_EJS_REMOTE_COMPONENTS=ejs:github` (optional)
- `INFO_TIMEOUT_MS=45000`
- `DOWNLOAD_TIMEOUT_MS=240000`
- `MAX_ACTIVE_JOBS=2`

Do not commit secrets.

## Health checks

- `/api/health`
- `/healthz`

## Important runtime note

The Vercel API performs a download during the request and streams the resulting file back to the browser. It does not use a persistent Node server or a background job queue.

Audio downloads use the source audio container available from yt-dlp (for example M4A/WebM) because this deployment does not install a system FFmpeg package.


## YouTube PO Token provider

The Vercel build prepares bgutil-ytdlp-pot-provider 2.0.0 with its development dependencies so the TypeScript provider can compile on Vercel. The generated provider plugin and server are bundled into the API function and yt-dlp is invoked with the provider plugin directory, script server home, and the mweb client. No personal YouTube cookies are required by this configuration.

## V11 static CSS deployment fix
The stylesheet is intentionally served from `frontend/public/style.css` as `/style.css` rather than relying on a hashed Vite CSS asset. This avoids Vercel static-asset routing/cache issues that can cause a generated `/assets/style-*.css` request to return 500/404.


## YouTube anti-bot note
The API defaults to the `mweb` YouTube client so the bundled bgutil PO-token provider can be used. Set `YOUTUBE_PLAYER_CLIENT` in Vercel only if you intentionally need a different client. A `youtube: Sign in to confirm you’re not a bot` response can still mean the configured YouTube cookies are expired/invalid or that YouTube is challenging the Vercel IP; the `/api/health` `youtubeCookiesConfigured` flag only confirms the environment variable exists, not that YouTube accepts the session. Refresh the Netscape-format YouTube cookies if this error persists.
