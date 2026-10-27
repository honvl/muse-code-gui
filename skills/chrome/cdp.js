#!/usr/bin/env node
// cdp.js — Chrome DevTools Protocol automation. Zero dependencies (Node 22+).
// Works against any Chrome with --remote-debugging-port. Prefer `launch`
// (disposable profile) over attaching to the user's live browser.
//
// Usage:
//   node cdp.js launch [--port 9222] [--profile /tmp/chrome-pi-debug] [--headed] [--url <url>]
//   node cdp.js watch <url> [--port 9222]   (headed tab behind your windows, no focus steal)
//   node cdp.js targets [--port 9222]
//   node cdp.js new <url> [--port 9222]
//   node cdp.js navigate <targetId> <url> [--port 9222]
//   node cdp.js eval <targetId> "<js expression>" [--port 9222]
//   node cdp.js text <targetId> [--port 9222]
//   node cdp.js html <targetId> [--max 20000] [--port 9222]
//   node cdp.js click <targetId> "<css selector>" [--port 9222]
//   node cdp.js type <targetId> "<css selector>" "<text>" [--port 9222]
//   node cdp.js wait <targetId> "<css selector>" [--timeout 10000] [--port 9222]
//   node cdp.js screenshot <targetId> <out.png> [--port 9222]
//   node cdp.js activate <targetId> [--port 9222]
//   node cdp.js close <targetId> [--port 9222]

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_PORT = 9222;
// Persistent (not /tmp) so logins/cookies survive reboots. Delete this
// folder to log out. Old ephemeral default was /tmp/chrome-pi-debug.
const DEFAULT_PROFILE = join(homedir(), ".pi/agent/skills/chrome/profile");

function fail(msg) {
  console.error(`cdp.js: ${msg}`);
  process.exit(1);
}

function opts(argv) {
  const o = { port: DEFAULT_PORT };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--profile") o.profile = argv[++i];
    else if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else if (a === "--url") o.url = argv[++i];
    else if (a === "--headed") o.headed = true;
    else if (a === "--background") o.background = true;
    else if (a.startsWith("--")) fail(`unknown flag ${a}`);
    else pos.push(a);
  }
  return { o, pos };
}

const base = (port) => `http://127.0.0.1:${port}`;

async function getJson(port, path) {
  const res = await fetch(base(port) + path);
  if (!res.ok) fail(`CDP http ${res.status} on ${path} (is Chrome listening on port ${port}? Try: node cdp.js launch --port ${port})`);
  return res.json();
}

async function findTarget(port, targetId) {
  const targets = await getJson(port, "/json/list");
  const t = targets.find((t) => t.id === targetId || t.title === targetId);
  if (!t) {
    const ids = targets.map((t) => `${t.id} ${t.type} ${t.url}`).join("\n  ");
    fail(`target not found: ${targetId}\n  available:\n  ${ids || "(none)"}`);
  }
  if (!t.webSocketDebuggerUrl) fail(`target ${targetId} has no debugger URL (type=${t.type})`);
  return t;
}

// Minimal CDP session over global WebSocket.
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const timer = setTimeout(() => reject(new Error("websocket connect timeout")), 15000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}, timeoutMs = 20000) {
          return new Promise((res, rej) => {
            const callId = ++id;
            const to = setTimeout(() => {
              pending.delete(callId);
              rej(new Error(`CDP timeout: ${method}`));
            }, timeoutMs);
            pending.set(callId, { res, rej, to, method });
            ws.send(JSON.stringify({ id: callId, method, params }));
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, to, method } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(to);
        if (msg.error) rej(new Error(`CDP ${method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else res(msg.result);
      }
    });
    ws.addEventListener("error", (ev) => {
      const err = ev && ev.message ? ev.message : "websocket error";
      // Only reject if still waiting to connect.
      reject(new Error(String(err)));
    });
  });
}

async function withSession(port, targetId, fn) {
  const t = await findTarget(port, targetId);
  const session = await connect(t.webSocketDebuggerUrl);
  try {
    // Best-effort domain enable; ignore failures on minimal targets.
    await session.send("Page.enable", {}).catch(() => {});
    await session.send("Runtime.enable", {}).catch(() => {});
    return await fn(session);
  } finally {
    session.close();
  }
}

async function evaluate(session, expression, awaitPromise = false) {
  const r = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const text = r.exceptionDetails.text || "exception";
    const val = r.exceptionDetails.exception
      ? JSON.stringify(r.exceptionDetails.exception).slice(0, 500)
      : "";
    throw new Error(`page threw: ${text} ${val}`);
  }
  return r.result && "value" in r.result ? r.result.value : undefined;
}

// Start (or reuse) a debug-profile Chrome. Headless = no UI at all.
// Headed + background = visible window kept behind the current app (`open -g`).
async function startDebugChrome(port, profile, { headed, background, url }) {
  try {
    const v = await getJson(port, "/json/version");
    return { reused: true, version: v };
  } catch {}
  try { mkdirSync(profile, { recursive: true }); } catch {}
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
  ];
  if (!headed) args.push("--headless");
  args.push(url || "about:blank");
  if (headed && background) {
    const child = spawn("open", ["-n", "-g", "-a", "Google Chrome", "--args", ...args], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } else {
    const child = spawn(CHROME_PATH, args, { detached: true, stdio: "ignore" });
    child.unref();
  }
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const v = await getJson(port, "/json/version");
      return { reused: false, version: v };
    } catch {
      if (Date.now() > deadline) fail(`Chrome did not start listening on ${port}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

async function openTab(port, url) {
  const res = await fetch(base(port) + `/json/new?${new URLSearchParams({ url }).toString()}`, { method: "PUT" });
  if (!res.ok) fail(`could not open tab (http ${res.status})`);
  return res.json();
}

const [cmd, ...rest] = process.argv.slice(2);
const { o, pos } = opts(rest);

switch (cmd) {
  case "launch": {
    const port = o.port;
    const profile = o.profile || DEFAULT_PROFILE;
    const { reused, version } = await startDebugChrome(port, profile, {
      headed: o.headed,
      background: o.background,
      url: o.url,
    });
    console.log(
      reused
        ? `already listening on ${port} (${(version && version.Browser) || "Chrome"})`
        : `launched debug Chrome on port ${port} (profile ${profile}, ${(version && version.Browser) || ""})`.trim()
    );
    break;
  }

  case "watch": {
    const url = pos[0] || o.url;
    if (!url) fail("usage: node cdp.js watch <url> [--port 9222] [--profile DIR]");
    const port = o.port;
    const profile = o.profile || DEFAULT_PROFILE;
    const { reused, version } = await startDebugChrome(port, profile, {
      headed: true,
      background: true,
      url: "about:blank",
    });
    const t = await openTab(port, url);
    console.log(JSON.stringify({
      id: t.id,
      url: t.url || url,
      port,
      mode: reused
        ? "attached to running debug Chrome"
        : "launched headed debug Chrome behind your windows",
      browser: (version && version.Browser) || "",
      note: "Visible window, stays behind your work. Drive it with eval/click/type/screenshot — " +
        "none of these move OS focus. Do not minimize it (minimized pages throttle).",
    }, null, 2));
    break;
  }

  case "targets": {
    const targets = await getJson(o.port, "/json/list");
    console.log(
      JSON.stringify(
        targets.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url })),
        null,
        2
      )
    );
    break;
  }

  case "new": {
    const url = pos[0];
    if (!url) fail("usage: node cdp.js new <url> [--port 9222]");
    const res = await fetch(base(o.port) + `/json/new?${new URLSearchParams({ url }).toString()}`, { method: "PUT" });
    if (!res.ok) fail(`could not open tab (http ${res.status})`);
    const t = await res.json();
    console.log(JSON.stringify({ id: t.id, title: t.title, url: t.url }, null, 2));
    break;
  }

  case "navigate": {
    const [targetId, url] = pos;
    if (!targetId || !url) fail("usage: node cdp.js navigate <targetId> <url>");
    await withSession(o.port, targetId, (s) => s.send("Page.navigate", { url }));
    console.log(`navigated ${targetId} to ${url}`);
    break;
  }

  case "eval": {
    const [targetId, expr] = pos;
    if (!targetId || !expr) fail('usage: node cdp.js eval <targetId> "<js expression>"');
    const value = await withSession(o.port, targetId, (s) => evaluate(s, expr, true));
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    break;
  }

  case "text": {
    const [targetId] = pos;
    if (!targetId) fail("usage: node cdp.js text <targetId>");
    const value = await withSession(o.port, targetId, (s) =>
      evaluate(s, `(document.body ? document.body.innerText : '')`)
    );
    console.log(value ?? "");
    break;
  }

  case "html": {
    const [targetId] = pos;
    if (!targetId) fail("usage: node cdp.js html <targetId> [--max 20000]");
    const max = o.max ?? 20000;
    const value = await withSession(o.port, targetId, (s) =>
      evaluate(s, `document.documentElement ? document.documentElement.outerHTML : ''`)
    );
    const html = String(value ?? "");
    console.log(html.length > max ? html.slice(0, max) + `\n...[truncated ${html.length - max} of ${html.length} chars]` : html);
    break;
  }

  case "click": {
    const [targetId, selector] = pos;
    if (!targetId || !selector) fail('usage: node cdp.js click <targetId> "<css selector>"');
    const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'NOTFOUND'; el.scrollIntoView({block: 'center'}); el.click(); return 'OK:' + el.tagName; })()`;
    const value = await withSession(o.port, targetId, (s) => evaluate(s, expr));
    if (value === "NOTFOUND") fail(`no element matches ${selector}`);
    console.log(value);
    break;
  }

  case "type": {
    const [targetId, selector, ...textParts] = pos;
    if (!targetId || !selector || textParts.length === 0) fail('usage: node cdp.js type <targetId> "<css selector>" "<text>"');
    const text = textParts.join(" ");
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOTFOUND';
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      try {
        if (el.isContentEditable) { el.textContent = ${JSON.stringify(text)}; }
        else if (native && /INPUT|TEXTAREA|SELECT/.test(el.tagName)) { native.call(el, ${JSON.stringify(text)}); }
        else { el.value = ${JSON.stringify(text)}; }
      } catch (e) { el.value = ${JSON.stringify(text)}; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'OK:' + el.tagName;
    })()`;
    const value = await withSession(o.port, targetId, (s) => evaluate(s, expr));
    if (value === "NOTFOUND") fail(`no element matches ${selector}`);
    console.log(value);
    break;
  }

  case "wait": {
    const [targetId, selector] = pos;
    if (!targetId || !selector) fail('usage: node cdp.js wait <targetId> "<css selector>" [--timeout 10000]');
    const timeout = o.timeout ?? 10000;
    const deadline = Date.now() + timeout;
    let found = false;
    while (Date.now() < deadline) {
      const v = await withSession(o.port, targetId, (s) =>
        evaluate(s, `!!document.querySelector(${JSON.stringify(selector)})`)
      );
      if (v) { found = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!found) fail(`timed out after ${timeout}ms waiting for ${selector}`);
    console.log(`found ${selector}`);
    break;
  }

  case "screenshot": {
    const [targetId, out] = pos;
    if (!targetId || !out) fail("usage: node cdp.js screenshot <targetId> <out.png>");
    const { data } = await withSession(o.port, targetId, (s) =>
      s.send("Page.captureScreenshot", { format: "png" })
    );
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`saved ${out}`);
    break;
  }

  case "activate": {
    const [targetId] = pos;
    if (!targetId) fail("usage: node cdp.js activate <targetId>");
    await fetch(base(o.port) + `/json/activate/${targetId}`);
    console.log(`activated ${targetId}`);
    break;
  }

  case "close": {
    const [targetId] = pos;
    if (!targetId) fail("usage: node cdp.js close <targetId>");
    await fetch(base(o.port) + `/json/close/${targetId}`);
    console.log(`closed ${targetId}`);
    break;
  }

  default:
    console.error(`usage: node cdp.js <launch|watch|targets|new|navigate|eval|text|html|click|type|wait|screenshot|activate|close> [options]
  launch [--port 9222] [--profile DIR] [--headed [--background]] [--url <url>]
  watch <url> [--port 9222] [--profile DIR]
  targets [--port 9222]
  new <url> [--port 9222]
  navigate <targetId> <url>
  eval <targetId> "<js expression>"
  text|html|screenshot|activate|close ...
  click|type|wait <targetId> "<css selector>" ...`);
    process.exit(1);
}
