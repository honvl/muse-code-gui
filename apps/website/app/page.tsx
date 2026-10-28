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

const showcase = [
  {
    eyebrow: "Lead and sidekicks",
    title: "A lead agent that hands out the work",
    body: "Switch a thread to Lead in the model picker and it plans, then hands the busywork — reading, searching and editing — to child threads running a cheap sidekick model (default lead, scout and sidekick models are in Settings). Scouts read and search but can't edit; workers edit inside their own write scope, so workers on different folders run in parallel. Each child reports back when it finishes, and the Session rail shows children live, with token usage split between the lead and delegated threads.",
    Illustration: LeadIllustration,
  },
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
    eyebrow: "Background tasks",
    title: "Dev servers and watchers that keep running",
    body: "The agent can start a long command in the background, keep working, read its output later and stop it. Running tasks show in the Session rail, where you can open their output or stop them.",
    Illustration: TasksIllustration,
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
    title: "Sessions that heal themselves",
    body: "When a provider rejects a request because of broken tool-call history, the bad turns are dropped and the session compacted before the prompt, instead of the thread failing for good.",
  },
  {
    title: "Queue and steer",
    body: "Line up follow-ups while a run is going, or steer the current run without stopping it.",
  },
  {
    title: "Threads that talk to each other",
    body: "Agents can list other threads, read their transcripts and send them follow-ups. Child threads nest under their lead in the sidebar.",
  },
  {
    title: "Scheduled tasks",
    body: "Have the app rerun a prompt on a schedule, such as a weekly dependency check, while the app is open.",
  },
  {
    title: "Delegation guardrails",
    body: "A per-thread budget of 30 children, one writer per write scope, scouts can't spawn workers; children can't leave the workspace, write .env files, run destructive commands or nest more than three levels deep.",
  },
  {
    title: "Skills and extensions",
    body: "Turn skills and extensions on and off, try them from the composer, and give extensions their own tabs. One Settings switch installs the Muse Code GUI pack, with a Chrome browser-control skill and usage views.",
  },
  {
    title: "Any provider",
    body: "Sign in with OAuth, paste an API key, or point at a custom endpoint. Pick the model per thread; the thinking-level picker only offers levels the selected model supports.",
  },
  {
    title: "Your sessions, on disk",
    body: "Your sessions are plain files on disk, so your threads, credentials and skills carry over."
  },
  {
    title: "Fork and rewind",
    body: "Fork a thread from any message into the same checkout or a new worktree — even while the current run is still going — and move around the session tree.",
  },
  {
    title: "Automatic updates",
    body: "The app downloads updates from GitHub Releases and installs them on restart. Long threads stay fast thanks to incremental transcript publishing and smaller saved state.",
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
    q: "Which models can I use?",
    a: "Any major provider via OAuth sign-in, API key or a custom endpoint, with model and thinking level set per thread. Lead and sidekick models are set separately — see Recommended pairings below.",
  },
  {
    q: "Does it cost anything?",
    a: (
      <>
        Muse Code GUI is free and MIT licensed. You pay your model provider. Pairing a strong
        lead with a cheap sidekick cut costs about 64% in our measurements — see{" "}
        <a href="#pairings">Recommended pairings</a>.
      </>
    ),
  },
  {
    q: "Where does my code go?",
    a: "The app runs on your machine. Your code goes only to the model provider you configure. The app also checks GitHub for new releases.",
  },
  {
    q: "How do updates work?",
    a: (
      <>
        The app downloads updates from GitHub Releases and installs them on restart. Homebrew
        installs can use <code>brew upgrade --cask</code>.
      </>
    ),
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
            <a href="#pairings">Pairings</a>
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
            <a className="hero__badge" href={RELEASES_URL}>
              Free and open source for macOS, Linux and Windows
              <span aria-hidden="true">→</span>
            </a>
            <h1>Coding agents that work as a team</h1>
            <p className="hero__lede">
              Muse Code GUI is a desktop app for AI coding agents. A strong lead plans and
              reviews, while a fast, cheap sidekick does the reading, searching and editing —
              and you review every change, run the tests in a real terminal, and ship without
              leaving the window.
            </p>
            <div className="hero__actions">
              <DownloadButton className="button button--primary" />
              <a className="button button--secondary" href={GITHUB_URL}>
                View on GitHub
              </a>
            </div>
            <p className="hero__note">Free and MIT licensed.</p>
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

        <section id="pairings" className="pairings">
          <div className="container">
            <p className="eyebrow eyebrow--center">Recommended pairings</p>
            <h2 className="section-title">Same work, about two thirds cheaper</h2>
            <p className="pairings__stat">
              <span className="pairings__stat-number">64% lower cost</span>
            </p>
            <p className="section-lede">
              A strong lead plans and reviews. A fast, cheap sidekick does the reading,
              searching and editing.
            </p>
            <div className="pairings__bars">
              <div className="pairings__bar-row">
                <div className="pairings__bar-meta">
                  <span>Claude Opus 5.5 alone</span>
                  <strong>$51.56</strong>
                </div>
                <div className="pairings__track">
                  <div className="pairings__bar pairings__bar--full" style={{ width: "100%" }} />
                </div>
              </div>
              <div className="pairings__bar-row">
                <div className="pairings__bar-meta">
                  <span>Opus 5.5 lead + Muse Spark 1.3 Contributor sidekicks</span>
                  <strong>$18.53</strong>
                </div>
                <div className="pairings__track">
                  <div className="pairings__bar" style={{ width: "36%" }} />
                </div>
              </div>
              <p className="pairings__caption">
                Measured: same 3 real lead threads, 12 delegated tasks. Per-thread savings
                ranged 37% to 79%.
              </p>
            </div>
            <div className="pairings__prices">
              <div className="pairings__price">
                <p className="pairings__price-model">Claude Opus 5.5</p>
                <p className="pairings__price-numbers">$4 / $20</p>
                <p className="pairings__price-meta">per 1M tokens, in / out</p>
              </div>
              <div className="pairings__price">
                <p className="pairings__price-model">Muse Wonder</p>
                <p className="pairings__price-numbers">$4 / $20</p>
                <p className="pairings__price-meta">per 1M tokens, in / out</p>
              </div>
              <div className="pairings__price">
                <p className="pairings__price-model">Muse Spark 1.3 Contributor</p>
                <p className="pairings__price-numbers">$0.10 / $0.20</p>
                <p className="pairings__price-meta">per 1M tokens, in / out</p>
              </div>
              <p className="pairings__prices-note">
                40× cheaper input, 100× cheaper output than the lead models.
              </p>
            </div>
            <div className="pairings__cards">
              <div className="pairings__card">
                <p className="pairings__card-badge">Recommended</p>
                <h3>Hard bugs and large refactors</h3>
                <p className="pairings__combo">
                  Lead: Claude Opus 5.5 · high
                  <br />
                  Sidekick: Muse Spark 1.3 Contributor · xhigh
                </p>
                <p className="pairings__bestfor">
                  Best for hard bugs and large refactors where planning quality matters.
                </p>
                <p className="pairings__cost">
                  Measured: 64% lower cost than Opus alone.
                </p>
              </div>
              <div className="pairings__card">
                <h3>Long-context work on big codebases</h3>
                <p className="pairings__combo">
                  Lead: Muse Wonder · high
                  <br />
                  Sidekick: Muse Spark 1.3 Contributor · xhigh
                </p>
                <p className="pairings__bestfor">
                  Best for long-context work across big codebases (1M-token context).
                </p>
                <p className="pairings__cost">
                  Estimated: similar savings. Wonder has the same list price as Opus 5.5.
                </p>
              </div>
            </div>
            <p className="pairings__howto">
              How to set it: Settings → Default lead model, Default scout model; or the Lead
              toggle and Sidekick picker in the composer.
            </p>
            <p className="pairings__footnote">
              Measured on the maintainer&apos;s own lead threads in October 2026: 3 threads led
              by Claude Opus 5.5 with 12 child tasks on Muse Spark 1.3 Contributor. The
              comparison prices the children&apos;s tokens at the lead model&apos;s list price,
              assuming the lead would have used the same number of tokens. Your savings depend
              on how much work the lead delegates.
            </p>
          </div>
        </section>

        <section id="features" className="showcase">
          <div className="container">
            <h2 className="section-title">One window for the whole job</h2>
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
                {"Illustration" in item ? (
                  <figure className="frame" style={{ margin: 0 }}>
                    <item.Illustration />
                    <figcaption className="figure-note">Illustration</figcaption>
                  </figure>
                ) : (
                  <div className="frame">
                    <ThemedShot
                      name={item.shot}
                      alt={item.alt}
                      width={item.width}
                      height={item.height}
                      dark={item.dark}
                    />
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="grid-section">
          <div className="container">
            <h2 className="section-title">And the rest of the workflow</h2>
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
            <h2>Give your agent a team</h2>
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
            <a href={`${GITHUB_URL}/blob/main/LICENSE`}>MIT License</a>
          </nav>
        </div>
        <div className="footer__inner" style={{ paddingTop: 0 }}>
          <p className="credit" style={{ marginTop: 0 }}>
            MIT licensed. Originally based on <a href={UPSTREAM_URL}>pi-gui</a> by{" "}
            <a href={UPSTREAM_AUTHOR_URL}>Matthew Lam</a>.
          </p>
        </div>
      </footer>
    </>
  );
}
