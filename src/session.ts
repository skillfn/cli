import { readFile, writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const SESSION_DIR = join(homedir(), ".skillfn");
const SESSION_PATH = join(SESSION_DIR, "session.json");

// skillfn.dev is NOT owned/live -- the plan is a .com (this becomes a social-network-like
// product, see extra/plans/00-MASTERPLAN.md), not yet purchased. Real, currently-live
// default is the Vercel-assigned alias until a real domain exists and DNS is pointed.
export const HUB_URL = process.env.SKILLFN_HUB_URL ?? "https://skillfn.vercel.app";

export interface Session {
  accessToken: string;
  refreshToken: string;
}

export async function loadSession(): Promise<Session | undefined> {
  try {
    const raw = await readFile(SESSION_PATH, "utf8");
    return JSON.parse(raw) as Session;
  } catch {
    return undefined;
  }
}

async function saveSession(session: Session): Promise<void> {
  await mkdir(SESSION_DIR, { recursive: true });
  await writeFile(SESSION_PATH, JSON.stringify(session, null, 2) + "\n", "utf8");
  await chmod(SESSION_PATH, 0o600);
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // best-effort -- the printed URL is the real fallback, not an error condition
  }
}

/**
 * Browser device-flow login, same shape as `gh auth login` / `vercel login` -- chosen
 * explicitly over a copy-paste token for lowest funnel friction (see
 * extra/plans/09-growth-funnel-and-business-model.md and the Phase 2 planning discussion):
 * a first-time publisher never runs a separate login command, `publish` triggers this
 * inline and continues straight through once it completes.
 *
 * No token refresh in v1 (extra/plans/07-roadmap.md Phase 2 notes) -- an expired token
 * just re-triggers this flow.
 */
export async function login(): Promise<Session> {
  const state = randomBytes(16).toString("hex");

  // Only the hub's own origin, never "*" -- this server briefly accepts a session token.
  const allowedOrigin = new URL(HUB_URL).origin;

  const session = await new Promise<Session>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      // The browser sends a CORS preflight OPTIONS request before the actual POST,
      // since a JSON content-type isn't CORS-"simple" -- without answering this, the
      // browser blocks the POST entirely before it's even sent (confirmed by testing
      // against the real hub, not assumed).
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
        }).end();
        return;
      }

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
        try {
          const payload = JSON.parse(body) as {
            access_token?: string;
            refresh_token?: string;
            state?: string;
          };
          if (payload.state !== state || !payload.access_token || !payload.refresh_token) {
            res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid callback.");
            reject(new Error("Login callback failed state check or was missing tokens."));
            server.close();
            return;
          }
          res
            .writeHead(200, { "Content-Type": "text/html" })
            .end("<html><body>Connected — you can return to your terminal.</body></html>");
          resolve({ accessToken: payload.access_token, refreshToken: payload.refresh_token });
          server.close();
        } catch (err) {
          res.writeHead(500).end();
          reject(err);
          server.close();
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const authUrl = `${HUB_URL}/cli-auth?port=${port}&state=${state}`;
      console.log(`\nOpening your browser to sign in: ${authUrl}`);
      console.log("(If it doesn't open automatically, visit that URL yourself.)\n");
      openBrowser(authUrl);
    });

    server.on("error", reject);
  });

  await saveSession(session);
  return session;
}

/** Ensures a session exists, triggering the device-flow login inline if it doesn't. */
export async function ensureSession(): Promise<Session> {
  const existing = await loadSession();
  if (existing) return existing;
  return login();
}

async function clearSession(): Promise<void> {
  try {
    await rm(SESSION_PATH);
  } catch {
    // already gone -- fine
  }
}

/**
 * POSTs JSON with the current session's bearer token; on a 401 (expired/invalid session --
 * a real gap a human retest found, 2026-08-20: the old error message told the user to "run
 * publish again to re-authenticate" but nothing actually re-triggered login, since a stale
 * session.json still existed locally) it clears the stale session, runs the browser login
 * flow again inline, and retries the request ONCE with the fresh token -- no second manual
 * command needed.
 */
export async function postJsonWithReauth(url: string, body: unknown): Promise<Response> {
  const session = await ensureSession();
  const doPost = (token: string) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  let response = await doPost(session.accessToken);
  if (response.status === 401) {
    await clearSession();
    console.log("\nYour session expired -- signing in again…");
    const fresh = await login();
    response = await doPost(fresh.accessToken);
  }
  return response;
}
