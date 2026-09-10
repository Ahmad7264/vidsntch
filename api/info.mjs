import app from "./index.mjs";

export default function handler(req, res) {
  const url = new URL(req.url || "/", "http://vercel.local");
  req.url = `/api/info${url.search}`;
  return app(req, res);
}
