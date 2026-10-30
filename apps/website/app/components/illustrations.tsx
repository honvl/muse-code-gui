// Stylised HTML illustrations of product concepts. They are drawn, not captured, so each one
// is labelled "Illustration" in its caption on the page.

function WindowChrome({ title, pill }: { readonly pill?: string; readonly title: string }) {
  return (
    <div className="mock__chrome" aria-hidden="true">
      <span className="mock__dot" />
      <span className="mock__dot" />
      <span className="mock__dot" />
      <span className="mock__title">{title}</span>
      {pill ? <span className="mock__pill">{pill}</span> : null}
    </div>
  );
}

const children = [
  { mode: "scout", title: "Map how token refresh works", status: "done", meta: "1m 12s" },
  { mode: "worker", title: "Fix refresh race · src/auth/", status: "running", meta: "editing" },
  {
    mode: "worker",
    title: "Add retry tests · test/auth/",
    status: "running",
    meta: "running tests",
  },
  { mode: "scout", title: "Check other callers of refresh()", status: "queued", meta: "queued" },
] as const;

export function LeadIllustration() {
  return (
    <div className="mock" role="img" aria-label="A lead thread delegating to four child threads">
      <WindowChrome
        title="Fix flaky auth refresh"
        pill="Lead · Opus 5.5 · Sidekick: Muse Spark 1.3 Contributor"
      />
      <div className="mock__split">
        <div className="mock__thread">
          <div className="mock__bubble mock__bubble--user">
            Login sometimes drops users after an hour. Find out why and fix it.
          </div>
          <p className="mock__assistant">
            I&apos;ll split this up. A scout maps the refresh flow, then two workers fix the race
            and add tests in separate folders, so they can edit at the same time.
          </p>
          <div className="mock__report">
            <span className="mock__report-label">Child report · scout</span>
            Refresh runs twice when two requests expire together; the second call reuses a revoked
            token. Entry point: src/auth/session.ts.
          </div>
        </div>
        <aside className="mock__rail">
          <p className="mock__rail-title">Children</p>
          {children.map((child) => (
            <div key={child.title} className="mock__child">
              <span className={`mock__status mock__status--${child.status}`} />
              <div>
                <p className="mock__child-title">{child.title}</p>
                <p className="mock__child-meta">
                  <span className={`mock__mode mock__mode--${child.mode}`}>{child.mode}</span>
                  {child.meta}
                </p>
              </div>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

const tasks = [
  { command: "pnpm dev", meta: "12m · port 5173", running: true },
  { command: "pnpm test --watch", meta: "4m · 212 passed", running: true },
  { command: "docker compose up db", meta: "31m", running: true },
  { command: "pnpm build", meta: "exited 0 · 48s", running: false },
] as const;

export function TasksIllustration() {
  return (
    <div
      className="mock"
      role="img"
      aria-label="Background tasks listed in the Session details rail"
    >
      <WindowChrome title="Session" />
      <div className="mock__body">
        <p className="mock__rail-title">Background tasks</p>
        {tasks.map((task) => (
          <div key={task.command} className="mock__task">
            <span className={`mock__status mock__status--${task.running ? "running" : "done"}`} />
            <div>
              <code>{task.command}</code>
              <p className="mock__task-meta">{task.meta}</p>
            </div>
            <div className="mock__task-actions">
              <span className="mock__task-action">Output</span>
              {task.running ? <span className="mock__task-action">Stop</span> : null}
            </div>
          </div>
        ))}
        <div className="mock__log">
          <span>VITE ready in 412 ms</span>
          <span>➜ Local: http://localhost:5173/</span>
          <span className="mock__log-dim">hmr update /src/auth/session.ts</span>
        </div>
      </div>
    </div>
  );
}

export function SuggestIllustration() {
  return (
    <div
      className="mock"
      role="img"
      aria-label="The composer showing a suggested next prompt in grey"
    >
      <WindowChrome title="Composer" />
      <div className="mock__body">
        <p className="mock__assistant">
          Fixed the refresh race and added two tests. All 214 tests pass.
        </p>
        <div className="mock__composer">
          <span className="mock__ghost">
            Now open a PR with a short summary of the race and the fix —{" "}
            <span className="mock__key">Tab</span> to use
          </span>
        </div>
      </div>
    </div>
  );
}

export function TranscriptIllustration() {
  return (
    <div
      className="mock"
      role="img"
      aria-label="A transcript with thinking, a grouped tool row and timings"
    >
      <WindowChrome title="Transcript" />
      <div className="mock__body">
        <div className="mock__bubble mock__bubble--user">
          Why does the dashboard render twice?
          <span className="mock__receipt">Read ✓✓</span>
        </div>
        <div className="mock__row">
          <span className="mock__chevron">›</span>
          Thinking
          <span className="mock__row-meta">8.2s</span>
        </div>
        <div className="mock__row">
          <span className="mock__chevron">›</span>
          Ran 7 tools · read ×5, grep, bash
          <span className="mock__row-meta">3.1s</span>
        </div>
        <p className="mock__assistant">
          <code>useDashboard</code> creates a new options object on every render, so the effect
          fires again. Memoising it removes the second render.
          <span className="mock__row-meta mock__row-meta--block">
            First token 1.2s · Generation 13.4s
          </span>
        </p>
      </div>
    </div>
  );
}
