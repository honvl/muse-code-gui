import { CopyCommand } from "./components/copy-command";
import { DownloadButton } from "./components/download-button";
import {
  LeadIllustration,
  SuggestIllustration,
  TasksIllustration,
  TranscriptIllustration,
} from "./components/illustrations";
import { ThemedShot } from "./components/themed-shot";
import {
  BREW_INSTALL,
  GITHUB_URL,
  OG_IMAGE_PATH,
  PI_URL,
  RELEASES_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
  UPSTREAM_AUTHOR_URL,
  UPSTREAM_URL,
} from "./site";

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  sameAs: [GITHUB_URL],
  image: `${SITE_URL}${OG_IMAGE_PATH}`,
  isAccessibleForFree: true,
  isBasedOn: UPSTREAM_URL,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

const additions = [
  {
    eyebrow: "Lead and sidekicks",
    title: "A lead agent that hands out the work",
    body: "Switch a thread to Lead in the model picker and it plans, then delegates to child threads running a cheaper sidekick model (default lead, scout and sidekick models are in Settings). Scouts read and search but can't edit; workers edit inside their own write scope, so workers on different folders run in parallel. Each child reports back when it finishes, and the Session rail shows children live, with token usage split between the lead and delegated threads.",
    Illustration: LeadIllustration,
  },
  {
    eyebrow: "Background tasks",
    title: "Dev servers and watchers that keep running",
    body: "The agent can start a long command in the background, keep working, read its output later and stop it. Running tasks show in the Session rail, where you can open their output or stop them.",
    Illustration: TasksIllustration,
  },
  {
    eyebrow: "Suggested prompts",
    title: "The next step, already typed",
    body: "When a run ends, the cheapest available model drafts the prompt you'd likely send next; it shows in grey in the composer, press Tab to use it or just type.",
    Illustration: SuggestIllustration,
  },
  {
    eyebrow: "Transcript",
    title: "See what the model did and how long it took",
    body: "Collapsible provider thinking, time to first token and generation time on each message, durations on tool calls, consecutive tool calls folded into one expandable row, read receipts on your messages.",
    Illustration: TranscriptIllustration,
  },
] as const;

const fixes = [
  {
    title: "Sessions that heal themselves",
    body: "When a provider rejects a request because of broken tool-call history, the bad turns are dropped and the session compacted before the prompt, instead of the thread failing for good.",
  },
  {
    title: "Threads that talk to each other",
    body: "Agents can list other threads, read their transcripts and send them follow-ups.",
  },
  {
    title: "Delegation guardrails",
    body: "A per-thread budget of 30 children, one writer per write scope, scouts can't spawn workers; children can't leave the workspace, write .env files, run destructive commands or nest more than three levels deep.",
  },
  {
    title: "Children where you expect them",
    body: "Child threads nest under their lead in the sidebar, and stuck or phantom “running” children after a restart are fixed.",
  },
  {
    title: "Fork while it runs",
    body: "Branch a thread without waiting for the current run to finish.",
  },
  {
    title: "Honest thinking levels",
    body: "The picker only offers levels the selected model supports.",
  },
  {
    title: "Extension pack",
    body: "One Settings switch installs the Muse Code GUI pack, with a Chrome browser-control skill and usage views.",
  },
  {
    title: "Updates from this fork",
    body: "The app updates itself from Muse Code GUI's own GitHub releases; long threads stay fast thanks to incremental transcript publishing and smaller saved state.",
  },
] as const;

const showcase = [
  {
    eyebrow: "Threads",
    title: "Run agents side by side",
    body: "Every task gets its own thread. Start it in your checkout or in a fresh git worktree, then start the next one while it works. The sidebar shows what is running, what finished and what needs you.",
    shot: "threads",
    width: 1640,
    height: 1026,
    dark: false,
    alt: "Running an agent thread while two other threads sit in the sidebar",
  },
  {
    eyebrow: "Review",
    title: "Review every change before it lands",
    body: "The Review tab shows exactly what the agent touched. Compare uncommitted work, a branch against its base, or a single turn, and stage it file by file.",
    shot: "review",
    width: 1240,
    height: 758,
    dark: true,
    alt: "The Review tab showing the diff an agent made to src/price.js",
  },
  {
    eyebrow: "Workbench",
    title: "Terminal and files in the same window",
    body: "Open a real terminal, browse and edit files, or manage worktrees in tabs beside the conversation. Each task keeps its own layout.",
    shot: "terminal",
    width: 1240,
    height: 992,
    dark: true,
    alt: "The integrated terminal running the test suite next to the thread",
  },
  {
    eyebrow: "Keyboard",
    title: "Everything is a keystroke away",
    body: "⌘K searches chats, workspaces and actions. ⌘P jumps to any file. Ctrl-Tab flips between recent threads, and ⌘1 to ⌘9 jump to threads in the sidebar. On Linux and Windows, use Ctrl.",
    shot: "palette",
    width: 1440,
    height: 1280,
    dark: true,
    alt: "The command palette listing recent chats and actions",
  },
] as const;

const features = [
  {
    title: "Queue and steer",
    body: "Line up follow-ups while a run is going, or steer the current run without stopping it.",
  },
  {
    title: "Scheduled tasks",
    body: "Have pi rerun a prompt on a schedule, such as a weekly dependency check, while the app is open.",
  },
  {
    title: "Skills and extensions",
    body: "Turn pi skills and extensions on and off, try them from the composer, and give extensions their own tabs.",
  },
  {
    title: "Any provider",
    body: "Sign in with OAuth, paste an API key, or point at a custom endpoint. Pick the model and thinking level per thread.",
  },
  {
    title: "Your sessions, on disk",
    body: "The app reads and writes pi's own session files. Anything you set up with the pi CLI carries over.",
  },
  {
    title: "Fork and rewind",
    body: "Fork a thread from any message into the same checkout or a new worktree, and move around the session tree.",
  },
  {
    title: "Notifications",
    body: "Get told when a background thread finishes, fails or needs your attention.",
  },
  {
    title: "Themes",
    body: "Light and dark, plus presets like Catppuccin, Tokyo Night, Nord, Dracula and GitHub.",
  },
] as const;

const installs = [
  {
    platform: "macOS",
    detail: "Apple Silicon. Signed and notarized.",
    steps:
      "Download the .dmg from GitHub Releases and drag the app into Applications, or install with Homebrew:",
    command: BREW_INSTALL,
  },
  {
    platform: "Linux",
    detail: "x64 AppImage or .deb.",
    steps: "Download the AppImage or the .deb package from GitHub Releases.",
  },
  {
    platform: "Windows",
    detail: "x64 installer or portable build.",
    steps:
      "Download the setup .exe or the portable .exe from GitHub Releases. Builds are not code-signed yet, so SmartScreen may ask you to confirm.",
  },
] as const;

const faqs = [
  {
    q: "How is this related to pi-gui?",
    a: (
      <>
        Muse Code GUI is an open source fork of <a href={UPSTREAM_URL}>pi-gui</a> by{" "}
        <a href={UPSTREAM_AUTHOR_URL}>Matthew Lam</a>. Everything pi-gui does is still here, and
        both projects are MIT licensed with the original copyright kept.
      </>
    ),
  },
  {
    q: "Why does the installed app say pi-gui?",
    a: "The project is renamed, but the app keeps pi-gui's binary, data folder and Homebrew cask names, so existing installs keep their sessions, settings and updates. Only the project name changed.",
  },
  {
    q: "What is pi?",
    a: (
      <>
        <a href={PI_URL}>pi</a> is an open source coding agent that runs in your terminal. Muse
        Code GUI is a desktop app on top of it: sessions, models, tools and auth all run through
        pi itself.
      </>
    ),
  },
  {
    q: "Does it cost anything?",
    a: "Muse Code GUI is free and MIT licensed. You bring your own model provider, through a subscription sign-in or an API key — and lead mode can save money by handing busywork to a cheaper sidekick model.",
  },
  {
    q: "Can I keep using the pi CLI?",
    a: "Yes. The app uses pi's own session files and settings, so threads, credentials and skills are shared between the two.",
  },
  {
    q: "Where does my code go?",
    a: "The app runs on your machine. Your code goes only to the model provider you configure, the same way it does with the pi CLI. The app also checks GitHub for new releases.",
  },
  {
    q: "How do updates work?",
    a: "The app downloads updates from this project's GitHub Releases and installs them on restart. Homebrew installs update with brew upgrade --cask pi-gui.",
  },
] as const;

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function Logo() {
  return (
    <a className="logo" href="#top" aria-label="Muse Code GUI home">
      <img src="/icon.svg" alt="" width={24} height={24} />
      <span>Muse Code GUI</span>
    </a>
  );
}

export default function Page() {
  return (
    <>
      <header className="nav">
        <div className="nav__inner">
          <Logo />
          <nav className="nav__links" aria-label="Main">
            <a href="#whats-new">What&apos;s new</a>
            <a href="#features">Features</a>
            <a href="#install">Install</a>
            <a href="#faq">FAQ</a>
            <a href={GITHUB_URL} className="nav__github">
              <GitHubIcon />
              GitHub
            </a>
          </nav>
          <DownloadButton className="button button--primary button--small" />
        </div>
      </header>

      <main id="top">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd) }}
        />

        <section className="hero">
          <div className="container">
            <a className="hero__badge" href={UPSTREAM_URL}>
              An open source fork of pi-gui
              <span aria-hidden="true">→</span>
            </a>
            <h1>pi-gui, with a lead agent that delegates</h1>
            <p className="hero__lede">
              Muse Code GUI keeps everything the pi desktop app does and adds lead threads that
              hand work to cheaper sidekick models, background tasks, suggested next prompts and
              sessions that recover on their own.
            </p>
            <div className="hero__actions">
              <DownloadButton className="button button--primary" />
              <a className="button button--secondary" href={GITHUB_URL}>
                View on GitHub
              </a>
            </div>
            <p className="hero__note">
              Free and MIT licensed for macOS, Linux and Windows. Built on{" "}
              <a href={UPSTREAM_URL}>pi-gui</a> and <a href={PI_URL}>pi</a>.
            </p>
          </div>
          <div className="container container--wide">
            <div className="frame frame--hero">
              <video
                autoPlay
                loop
                muted
                playsInline
                preload="auto"
                poster="/media/hero-poster.webp"
                width={1920}
                height={1200}
                aria-label="An agent fixing a bug, running the tests, then the change open in the review tab"
              >
                <source src="/media/hero.webm" type="video/webm" />
                <source src="/media/hero.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
        </section>

        <section id="whats-new" className="showcase showcase--fork">
          <div className="container">
            <p className="section-kicker">What this fork adds</p>
            <h2 className="section-title">Built for agents that work in teams</h2>
            {additions.map((item, index) => (
              <article
                key={item.title}
                className={`showcase__row${index % 2 === 1 ? " showcase__row--flip" : ""}`}
              >
                <div className="showcase__copy">
                  <p className="eyebrow">{item.eyebrow}</p>
                  <h2>{item.title}</h2>
                  <p>{item.body}</p>
                </div>
                <figure className="frame" style={{ margin: 0 }}>
                  <item.Illustration />
                  <figcaption className="figure-note">Illustration</figcaption>
                </figure>
              </article>
            ))}
          </div>
        </section>

        <section className="grid-section">
          <div className="container">
            <h2 className="section-title">And a lot of smaller fixes</h2>
            <div className="feature-grid">
              {fixes.map((fix) => (
                <div key={fix.title} className="feature-grid__item">
                  <h3>{fix.title}</h3>
                  <p>{fix.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="features" className="showcase showcase--upstream">
          <div className="container">
            <p className="section-kicker">Everything from pi-gui</p>
            <h2 className="section-title">The desktop app you already know</h2>
            {showcase.map((item, index) => (
              <article
                key={item.title}
                className={`showcase__row${index % 2 === 1 ? " showcase__row--flip" : ""}`}
              >
                <div className="showcase__copy">
                  <p className="eyebrow">{item.eyebrow}</p>
                  <h2>{item.title}</h2>
                  <p>{item.body}</p>
                </div>
                <div className="frame">
                  <ThemedShot
                    name={item.shot}
                    alt={item.alt}
                    width={item.width}
                    height={item.height}
                    dark={item.dark}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="grid-section">
          <div className="container">
            <h2 className="section-title">Plus the rest of the workflow</h2>
            <div className="feature-grid">
              {features.map((feature) => (
                <div key={feature.title} className="feature-grid__item">
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="install" className="install">
          <div className="container">
            <h2 className="section-title">Install Muse Code GUI</h2>
            <p className="section-lede">
              Download the latest build from <a href={RELEASES_URL}>GitHub Releases</a>, or install
              with Homebrew on macOS. Then connect a provider under Settings, add a project folder
              and start a thread.
            </p>
            <div className="install__grid">
              {installs.map((item) => (
                <div key={item.platform} className="install__card">
                  <h3>{item.platform}</h3>
                  <p className="install__detail">{item.detail}</p>
                  <p>{item.steps}</p>
                  {"command" in item ? <CopyCommand command={item.command} /> : null}
                </div>
              ))}
            </div>
            <p className="install__source">
              Building from source is for contributors: see the{" "}
              <a href={`${GITHUB_URL}#development`}>development guide</a>.
            </p>
          </div>
        </section>

        <section id="faq" className="faq">
          <div className="container container--narrow">
            <h2 className="section-title">Questions</h2>
            {faqs.map((item) => (
              <details key={item.q} className="faq__item">
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="closing">
          <div className="container">
            <h2>Give pi a team</h2>
            <div className="hero__actions">
              <DownloadButton className="button button--primary" />
              <a className="button button--secondary" href={GITHUB_URL}>
                View on GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footer__inner">
          <Logo />
          <nav className="footer__links" aria-label="Footer">
            <a href={GITHUB_URL}>GitHub</a>
            <a href={RELEASES_URL}>Releases</a>
            <a href={UPSTREAM_URL}>pi-gui (upstream)</a>
            <a href={PI_URL}>pi</a>
            <a href={`${GITHUB_URL}/blob/main/LICENSE`}>MIT License</a>
          </nav>
        </div>
        <div className="footer__inner" style={{ paddingTop: 0 }}>
          <p className="credit" style={{ marginTop: 0 }}>
            Muse Code GUI is an independent fork. Not affiliated with the pi-gui maintainers or
            Meta.
          </p>
        </div>
      </footer>
    </>
  );
}
