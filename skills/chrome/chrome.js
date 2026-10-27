#!/usr/bin/env node
// chrome.js — drive the user's live Google Chrome on macOS via AppleScript/JXA.
// Zero dependencies. Node 18+.
//
// Usage:
//   node chrome.js list
//   node chrome.js open <url> [--window]
//   node chrome.js activate --win <id> [--tab <n>]
//   node chrome.js reload|back|forward --win <id> --tab <n>
//   node chrome.js close --win <id> [--tab <n>]
//   node chrome.js js --win <id> --tab <n> "<javascript>"
//
// --win = window id from `list`, --tab = 1-based tab index from `list`.
// Omit --win/--tab to target the front window's active tab.

import { execFileSync } from "node:child_process";

const CHROME = "Google Chrome";

function runJxa(source) {
  const out = execFileSync("osascript", ["-l", "JavaScript", "-e", source], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim();
}

function runAppleScript(source) {
  const out = execFileSync("osascript", ["-e", source], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim();
}

function fail(msg) {
  console.error(`chrome.js: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--win" || a === "--tab" || a === "--window" || a === "--force" || a === "--timeout" || a === "--max") {
      if (a === "--window") {
        args.window = true;
      } else if (a === "--force") {
        args.force = true;
      } else {
        const v = argv[++i];
        if (v === undefined) fail(`missing value for ${a}`);
        args[a.slice(2)] = a === "--tab" || a === "--timeout" || a === "--max" ? Number(v) : v;
      }
    } else if (a.startsWith("--")) {
      fail(`unknown flag ${a}`);
    } else {
      args._.push(a);
    }
  }
  return args;
}

// Window/tab reference for AppleScript. Targets by stable window id.
function tabRef(win, tab) {
  const w = win
    ? `(first window whose id is ${Number(win)})`
    : `front window`;
  return tab ? `tab ${Number(tab)} of ${w}` : `active tab of ${w}`;
}

function cmdList() {
  const src = `
    const Chrome = Application('Google Chrome');
    const out = [];
    for (const w of Chrome.windows()) {
      const winId = String(w.id());
      let activeIdx = 0;
      try { activeIdx = w.activeTabIndex(); } catch (e) {}
      const tabs = w.tabs();
      for (let i = 0; i < tabs.length; i++) {
        let title = '', url = '';
        try { title = tabs[i].title(); } catch (e) {}
        try { url = tabs[i].url(); } catch (e) {}
        let tabId = '';
        try { tabId = String(tabs[i].id()); } catch (e) {}
        out.push({ winId, tabIndex: i + 1, tabId, active: (i + 1) === activeIdx, title, url });
      }
    }
    JSON.stringify(out);
  `;
  let raw;
  try {
    raw = runJxa(src);
  } catch (e) {
    fail(`could not talk to Google Chrome (is it running?). ${stderrOf(e)}`);
  }
  // Validate JSON, then pretty-print.
  try {
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  } catch {
    fail(`unexpected Chrome response: ${raw.slice(0, 200)}`);
  }
}

function stderrOf(e) {
  const s = e && e.stderr ? String(e.stderr).trim().split("\n").pop() : "";
  return s ? `(${s})` : "";
}

function cmdOpen(args) {
  const url = args._[1];
  if (!url) fail("usage: node chrome.js open <url> [--window]");
  if (args.window) {
    runAppleScript(`tell application "${CHROME}" to make new window`);
    // Navigate the new front window's active tab.
    runAppleScript(
      `tell application "${CHROME}" to set URL of active tab of front window to "${escapeAS(url)}"`
    );
  } else {
    runAppleScript(`tell application "${CHROME}" to open location "${escapeAS(url)}"`);
  }
  console.log(`opened ${url}${args.window ? " (new window)" : ""}`);
}

// Navigate an existing tab in place. Background-safe: never activates Chrome.
function cmdNavigate(args) {
  const { win, tab } = args;
  const url = args._[1];
  if (!url) fail("usage: node chrome.js navigate <url> [--win <id>] [--tab <n>]");
  try {
    runAppleScript(
      `tell application "${CHROME}" to set URL of ${tabRef(win, tab)} to "${escapeAS(url)}"`
    );
    console.log(`navigated ${win ? `window ${win} ` : ""}${tab ? `tab ${tab} ` : ""}to ${url}`);
  } catch (e) {
    fail(`navigate failed. ${stderrOf(e)}`);
  }
}

function cmdActivate(args) {
  const { win, tab } = args;
  if (!win && !tab) fail("usage: node chrome.js activate --win <id> [--tab <n>]");
  if (tab && !win) fail("activating a tab requires --win <id>");
  if (win && tab) {
    runAppleScript(
      `tell application "${CHROME}" to set active tab index of (first window whose id is ${Number(win)}) to ${Number(tab)}`
    );
  }
  if (win) {
    runAppleScript(
      `tell application "${CHROME}" to set index of (first window whose id is ${Number(win)}) to 1`
    );
  }
  runAppleScript(`tell application "${CHROME}" to activate`);
  console.log(win ? `activated window ${win}${tab ? ` tab ${tab}` : ""}` : "activated Chrome");
}

function cmdNav(kind, args) {
  const { win, tab } = args;
  const verbs = { reload: "reload", back: "go back", forward: "go forward" };
  const verb = verbs[kind];
  try {
    console.log(runAppleScript(`tell application "${CHROME}" to ${verb} ${tabRef(win, tab)}`));
  } catch (e) {
    fail(`${kind} failed. ${stderrOf(e)}`);
  }
}

function cmdClose(args) {
  const { win, tab } = args;
  if (!win) fail("usage: node chrome.js close --win <id> [--tab <n>]");
  if (!tab && !args.force) {
    fail(
      `refusing to close entire window ${win} without --force. ` +
        `Pass --tab <n> to close a single tab, or repeat with --force to close the whole window.`
    );
  }
  try {
    if (tab) {
      runAppleScript(
        `tell application "${CHROME}" to close tab ${Number(tab)} of (first window whose id is ${Number(win)})`
      );
      console.log(`closed tab ${tab} of window ${win}`);
    } else {
      runAppleScript(`tell application "${CHROME}" to close (first window whose id is ${Number(win)})`);
      console.log(`closed window ${win}`);
    }
  } catch (e) {
    fail(`close failed. ${stderrOf(e)}`);
  }
}

// Run JS in a LIVE tab (with your cookies/auth). Background-safe.
// Requires one-time: Chrome menu > View > Developer > Allow JavaScript from Apple Events.
function runJs(win, tab, code) {
  // AppleScript `execute ... javascript` needs the JS as a quoted string.
  const src = `tell application "${CHROME}" to execute ${tabRef(win, tab)} javascript "${escapeAS(code)}"`;
  try {
    return runAppleScript(src);
  } catch (e) {
    const err = stderrOf(e);
    if (/turned off|Allow JavaScript from Apple Events/i.test(err)) {
      fail(
        "Chrome is blocking JavaScript from Apple Events. " +
          "Enable it once via Chrome menu: View > Developer > Allow JavaScript from Apple Events."
      );
    }
    fail(`js execution failed. ${err}`);
  }
}

function cmdJs(args) {
  const { win, tab } = args;
  const code = args._[1];
  if (!code) fail('usage: node chrome.js js --win <id> --tab <n> "<javascript>"');
  console.log(runJs(win, tab, code));
}

function cmdText(args) {
  const { win, tab } = args;
  console.log(runJs(win, tab, `(document.body ? document.body.innerText : '')`));
}

function cmdHtml(args) {
  const { win, tab } = args;
  const max = args.max ?? 20000;
  const out = runJs(win, tab, `document.documentElement ? document.documentElement.outerHTML : ''`);
  console.log(out.length > max ? out.slice(0, max) + `\n...[truncated ${out.length - max} of ${out.length} chars]` : out);
}

function cmdClick(args) {
  const { win, tab } = args;
  const selector = args._[1];
  if (!selector) fail('usage: node chrome.js click "<css selector>" --win <id> --tab <n>');
  const code = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'NOTFOUND'; el.scrollIntoView({block: 'center'}); el.click(); return 'OK:' + el.tagName; })()`;
  const out = runJs(win, tab, code);
  if (out === 'NOTFOUND') fail(`no element matches ${selector}`);
  console.log(out);
}

function cmdType(args) {
  const { win, tab } = args;
  const selector = args._[1];
  const text = args._[2];
  if (!selector || text === undefined) fail('usage: node chrome.js type "<css selector>" "<text>" --win <id> --tab <n>');
  const code = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'NOTFOUND';
    el.focus();
    try {
      if (el.isContentEditable) { el.textContent = ${JSON.stringify(text)}; }
      else if (/INPUT|TEXTAREA|SELECT/.test(el.tagName)) {
        const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set
          || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (native) native.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
      } else { el.value = ${JSON.stringify(text)}; }
    } catch (e) { el.value = ${JSON.stringify(text)}; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'OK:' + el.tagName;
  })()`;
  const out = runJs(win, tab, code);
  if (out === 'NOTFOUND') fail(`no element matches ${selector}`);
  console.log(out);
}

function cmdWait(args) {
  const { win, tab } = args;
  const selector = args._[1];
  if (!selector) fail('usage: node chrome.js wait "<css selector>" --win <id> --tab <n> [--timeout 10000]');
  const timeout = args.timeout ?? 10000;
  const deadline = Date.now() + timeout;
  for (;;) {
    const out = runJs(win, tab, `!!document.querySelector(${JSON.stringify(selector)}) ? 'YES' : 'NO'`);
    if (out === 'YES') { console.log(`found ${selector}`); return; }
    if (Date.now() > deadline) fail(`timed out after ${timeout}ms waiting for ${selector}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
}

function escapeAS(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs([cmd, ...rest].filter(Boolean));

switch (cmd) {
  case "list":
    cmdList();
    break;
  case "open":
    cmdOpen(args);
    break;
  case "navigate":
    cmdNavigate(args);
    break;
  case "activate":
    cmdActivate(args);
    break;
  case "reload":
  case "back":
  case "forward":
    cmdNav(cmd, args);
    break;
  case "close":
    cmdClose(args);
    break;
  case "js":
  case "eval":
    cmdJs(args);
    break;
  case "text":
    cmdText(args);
    break;
  case "html":
    cmdHtml(args);
    break;
  case "click":
    cmdClick(args);
    break;
  case "type":
    cmdType(args);
    break;
  case "wait":
    cmdWait(args);
    break;
  default:
    console.error(`usage: node chrome.js <list|open|navigate|activate|reload|back|forward|close|js|text|html|click|type|wait> [options]
  list
  open <url> [--window]
  navigate <url> [--win <id>] [--tab <n>]
  activate --win <id> [--tab <n>]
  reload|back|forward [--win <id>] [--tab <n>]
  close --win <id> [--tab <n>]
  js|eval [--win <id>] [--tab <n>] "<javascript>"   (live tab, uses your logins)
  text [--win <id>] [--tab <n>]                        (live tab innerText)
  html [--win <id>] [--tab <n>] [--max N]              (live tab HTML)
  click "<selector>" --win <id> --tab <n>              (live tab, logged in)
  type "<selector>" "<text>" --win <id> --tab <n>
  wait "<selector>" --win <id> --tab <n> [--timeout ms]`);
    process.exit(1);
}
