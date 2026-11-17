const app = document.querySelector("#app");

const state = {
  phase: "loading",
  user: null,
  installUrl: null,
  repos: [],
  installationFilter: "all",
  error: "",
  repoError: "",
  modalRepo: null,
  modalError: "",
  branchDrafts: new Map(),
  repoNotices: new Map(),
  savingSettings: new Set(),
  optimizing: new Set(),
  stats: new Map(),
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function handleUnauthorized(error) {
  if (error.status !== 401) return false;
  state.user = null;
  state.phase = "loggedOut";
  state.modalRepo = null;
  state.modalError = "";
  return true;
}

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = text;
  return element;
}

function button(label, className, action, disabled = false) {
  const element = node("button", className, label);
  element.type = "button";
  element.disabled = disabled;
  element.addEventListener("click", action);
  return element;
}

/**
 * 即时反馈（UX）：点击瞬间进入忙碌态，导航/请求在后台继续。
 * 跨页跳转前的"无反应空窗"是体感卡顿的主因；光标要打在 documentElement 上
 * ——导航会立刻掐死页面帧，按钮自身的 cursor 往往来不及上屏。
 */
function markBusy(element, label) {
  element.classList.add("is-busy");
  element.setAttribute("aria-busy", "true");
  if (label) element.textContent = label;
  document.documentElement.style.cursor = "progress";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // A malformed response is reported below with its HTTP status.
  }
  if (!response.ok) {
    const messages = {
      400: "That change could not be saved. Check the value and try again.",
      403: "You do not have access to this repository.",
      429: "This installation has reached its daily optimization quota. Try again tomorrow.",
      500: "The service had a problem. Please try again.",
      502: "GitHub could not be reached. Please try again.",
    };
    const errorMessages = {
      unauthorized: "Your session has ended. Please sign in again.",
      forbidden: "You do not have access to this repository.",
      invalid_body:
        "That change could not be saved. Check the value and try again.",
      quota_exceeded:
        "This installation has reached its daily optimization quota. Try again tomorrow.",
      github_error: "GitHub could not be reached. Please try again.",
      internal_error: "The service had a problem. Please try again.",
    };
    const message =
      errorMessages[data?.error] ||
      messages[response.status] ||
      data?.error ||
      "Something went wrong. Please try again.";
    throw new ApiError(message, response.status);
  }
  return data;
}

/**
 * 隐藏的 QA/自动化预览入口（不进导航，纯 URL 钩子）：
 *   ?preview=logged-out   登录页
 *   ?preview=empty        空态（No installations found）
 *   ?preview=error        错误态
 * 正常访问完全不受影响；前端自动化用它覆盖边界分支。
 */
function applyPreview(preview) {
  if (preview === "logged-out") {
    state.phase = "loggedOut";
    return true;
  }
  if (preview === "error") {
    state.error = "";
    state.phase = "error";
    return true;
  }
  if (preview === "empty") {
    state.user = { login: null, userId: null };
    state.repos = [];
    state.repoError = "";
    state.phase = "ready";
    return true;
  }
  return false;
}

async function loadWorkspace() {
  const preview = new URLSearchParams(window.location.search).get("preview");
  if (applyPreview(preview)) {
    render();
    return;
  }
  state.phase = "loading";
  state.error = "";
  render();
  try {
    const user = await api("/api/me");
    state.user = user;
    state.installUrl = user.installUrl || null;
    try {
      state.repos = await api("/api/repos");
      state.repoError = "";
    } catch (error) {
      if (error.status === 401) throw error;
      state.repos = [];
      state.repoError = error.message;
    }
    state.phase = "ready";
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      state.phase = "loggedOut";
    } else {
      state.error = error.message;
      state.phase = "error";
    }
  }
  render();
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 0) return `−${formatBytes(Math.abs(bytes))}`;
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function relativeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const elapsed = date.getTime() - Date.now();
  const units = [
    ["year", 31_536_000_000],
    ["month", 2_592_000_000],
    ["week", 604_800_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const [unit, size] = units.find(([, size]) => Math.abs(elapsed) >= size) || [
    "second",
    1000,
  ];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(elapsed / size),
    unit,
  );
}

function dateText(value) {
  if (!value) return node("span", "muted", "—");
  const span = node("span", "date-value", relativeDate(value));
  span.title = formatDate(value);
  return span;
}

function formatState(value) {
  if (!value) return "No runs yet";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stateClass(value) {
  const normalized = String(value || "").toLowerCase();
  if (["done", "pr_open", "merged_cleanup", "merged"].includes(normalized))
    return "positive";
  if (normalized.startsWith("skipped")) return "neutral";
  if (normalized === "failed" || normalized === "aborted_by_human")
    return "negative";
  if (
    ["queued", "scanning", "optimizing", "committing", "open"].includes(
      normalized,
    )
  )
    return "working";
  return "neutral";
}

function repoPath(fullName, suffix) {
  const [owner, name] = fullName.split("/");
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${suffix}`;
}

function githubPullUrl(fullName, number) {
  return `https://github.com/${fullName}/pull/${number}`;
}

function render() {
  app.replaceChildren();
  if (state.phase === "loading") return renderLoading();
  if (state.phase === "loggedOut") return renderLogin();
  if (state.phase === "error") return renderError();
  renderDashboard();
}

function renderLoading() {
  const main = node("main", "boot-screen");
  main.setAttribute("aria-label", "Loading dashboard");
  main.setAttribute("role", "status");
  main.append(node("span", "loader"));
  main.lastChild.setAttribute("aria-hidden", "true");
  main.append(node("span", "", "Loading your workspace…"));
  app.append(main);
}

function brandMark() {
  const mark = node("span", "brand-mark", "i");
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

function renderLogin() {
  const page = node("main", "login-page");
  const top = node("header", "login-topbar");
  const identity = node("a", "brand-lockup");
  identity.href = "/";
  identity.append(brandMark(), node("span", "", "Imgbot"));
  const loginNav = node("nav", "login-nav");
  const docs = node("a", "documentation-link", "Documentation");
  docs.href = "/docs/";
  docs.target = "_blank";
  docs.rel = "noopener noreferrer";
  const signIn = node("a", "button button-quiet", "Sign in");
  signIn.href = "/api/auth/login";
  signIn.addEventListener("click", () => markBusy(signIn, "Opening…"));
  loginNav.append(docs, signIn);
  top.append(identity, loginNav);
  page.append(top);

  const layout = node("section", "login-layout");
  const story = node("div", "login-story");
  story.append(
    node("p", "eyebrow", "Your repositories, in better shape"),
    node("h1", "", "Smaller images.\nHappier repositories."),
    node(
      "p",
      "login-copy",
      "Imgbot finds the images in your GitHub projects and opens a tidy pull request with the lighter versions. You stay in control; your pages load a little faster.",
    ),
  );
  const proof = node("div", "login-proof");
  proof.append(
    node("span", "proof-dot"),
    node("span", "", "No changes are made without a pull request"),
  );
  story.append(proof);

  const card = node("section", "login-card");
  card.setAttribute("aria-labelledby", "login-title");
  const titleRow = node("div", "login-card-title");
  titleRow.append(node("span", "login-card-icon", "↗"));
  const title = node("h2", "", "Connect with GitHub");
  title.id = "login-title";
  titleRow.append(title);
  card.append(titleRow);
  card.append(
    node(
      "p",
      "login-card-copy",
      "Sign in to see your installed repositories and manage image optimization.",
    ),
  );
  card.append(
    node(
      "p",
      "login-card-note",
      "You’ll continue to GitHub to authorize the Imgbot app — no password is entered on this site.",
    ),
  );
  const login = node("a", "button button-primary login-button", "Sign in");
  login.href = "/api/auth/login";
  login.addEventListener("click", () => markBusy(login, "Opening GitHub…"));
  login.append(node("span", "button-arrow", "↗"));
  card.append(login);
  card.append(
    node(
      "p",
      "login-footnote",
      "You can review and change repository access on GitHub at any time.",
    ),
  );
  layout.append(story, card);
  page.append(layout);
  page.append(renderLoginMarketing());
  const footer = node("footer", "login-footer");
  footer.append(node("span", "", "A little less weight on every image."));
  page.append(footer);
  app.append(page);
}

function renderLoginMarketing() {
  const marketing = node("div", "login-marketing");

  const how = node("section", "marketing-section how-section");
  how.setAttribute("aria-labelledby", "how-title");
  const howHeading = node("div", "marketing-heading");
  howHeading.append(node("p", "eyebrow", "A simple rhythm"));
  const howTitle = node("h2", "", "How it works");
  howTitle.id = "how-title";
  howHeading.append(howTitle);
  const steps = node("ol", "steps-list");
  [
    [
      "1. Install",
      "Install Imgbot into your GitHub projects with the click of a button.",
    ],
    [
      "2. Merge",
      "Imgbot sends you a pull request with all of the images it can find optimized. Just merge it and you're done.",
    ],
    [
      "3. Win",
      "Imgbot watches for new images in your repository and opens more pull requests.",
    ],
  ].forEach(([title, copy]) => {
    const step = node("li", "step-card");
    step.append(node("h3", "", title));
    step.append(node("p", "", copy));
    steps.append(step);
  });
  how.append(howHeading, steps);
  marketing.append(how);

  const optimize = node("section", "marketing-section optimize-section");
  optimize.setAttribute("aria-labelledby", "optimize-title");
  const optimizeHeading = node("div", "marketing-heading");
  optimizeHeading.append(node("p", "eyebrow", "A lighter web"));
  const optimizeTitle = node("h2", "", "Why optimize your images?");
  optimizeTitle.id = "optimize-title";
  optimizeHeading.append(optimizeTitle);
  const optimizeCopy = node("div", "optimize-copy");
  optimizeCopy.append(
    node(
      "p",
      "",
      "When you're shipping code and hitting deadlines, it's easy to forget about optimizing your images. But the truth is, if you don't optimize your images, you are losing out.",
    ),
    node(
      "p",
      "",
      "Web pages with optimized images load faster. Faster pages have higher conversion rates, lower bounce rates, and happier users. And of course, smaller images reduce bandwidth costs for you and your visitors.",
    ),
  );
  optimize.append(optimizeHeading, optimizeCopy);
  marketing.append(optimize);

  const why = node("section", "marketing-section why-section");
  why.setAttribute("aria-labelledby", "why-title");
  const whyHeading = node("div", "marketing-heading");
  whyHeading.append(node("p", "eyebrow", "Made for the long run"));
  const whyTitle = node("h2", "", "Why use Imgbot?");
  whyTitle.id = "why-title";
  whyHeading.append(whyTitle);
  const whyIntro = node(
    "p",
    "why-intro",
    "Setting up and configuring your own tools can be a complicated and lengthy process. With just a few clicks, you can install Imgbot and permanently solve your image optimization problems.",
  );
  const benefits = node("ul", "benefit-list");
  [
    "Lossless optimization by default.",
    "Originals are replaced only when the optimized file is strictly smaller.",
    "Every result is decode-validated before it can replace a file.",
    "Use .imgbotconfig to choose ignored files, a schedule, and pull request title and body.",
    "Changes arrive as pull requests, so you stay in control.",
  ].forEach((copy) => {
    const item = node("li", "");
    item.append(node("span", "benefit-mark", "↗"));
    item.append(node("span", "", copy));
    benefits.append(item);
  });
  why.append(whyHeading, whyIntro, benefits);
  marketing.append(why);

  const closing = node("section", "login-closing");
  closing.setAttribute("aria-labelledby", "closing-title");
  const closingInner = node("div", "closing-inner");
  const closingTitle = node(
    "h2",
    "",
    "Optimize your images from now until forever.",
  );
  closingTitle.id = "closing-title";
  const signIn = node("a", "button button-primary closing-sign-in", "Sign in");
  signIn.href = "/api/auth/login";
  signIn.addEventListener("click", () => markBusy(signIn, "Opening GitHub…"));
  signIn.append(node("span", "button-arrow", "↗"));
  signIn.lastChild.setAttribute("aria-hidden", "true");
  closingInner.append(closingTitle, signIn);
  closing.append(closingInner);
  marketing.append(closing);

  return marketing;
}

function renderError() {
  const page = node("main", "center-state");
  const panel = node("section", "state-panel");
  panel.append(node("span", "state-symbol error-symbol", "!"));
  panel.append(node("p", "eyebrow", "We couldn’t load your workspace"));
  panel.append(node("h1", "", "That didn’t go to plan."));
  panel.append(
    node("p", "state-copy", state.error || "Please try again in a moment."),
  );
  panel.append(button("Try again", "button button-primary", loadWorkspace));
  const brand = node("a", "brand-lockup state-brand");
  brand.href = "/";
  brand.append(brandMark(), node("span", "", "Imgbot"));
  page.append(brand, panel);
  app.append(page);
}

function renderHeader() {
  const header = node("header", "app-header");
  const identity = node("a", "brand-lockup");
  identity.href = "/";
  identity.append(brandMark(), node("span", "", "Imgbot"));
  const divider = node("span", "header-divider");
  divider.setAttribute("aria-hidden", "true");
  const product = node("span", "header-context", "Repository dashboard");
  const docs = node("a", "documentation-link", "Documentation");
  docs.href = "/docs/";
  docs.target = "_blank";
  docs.rel = "noopener noreferrer";
  const account = node("div", "account-menu");
  const avatar = node(
    "span",
    "account-avatar",
    (state.user?.login || "?").slice(0, 1).toUpperCase(),
  );
  avatar.setAttribute("aria-hidden", "true");
  account.append(
    avatar,
    node("span", "account-login", state.user?.login || "GitHub user"),
  );
  const logout = button(
    "Sign out",
    "button button-quiet logout-button",
    signOut,
  );
  account.append(logout);
  header.append(identity, divider, product, docs, account);
  return header;
}

function renderDashboard() {
  const shell = node("div", "dashboard-shell");
  shell.append(renderHeader());
  const main = node("main", "dashboard-main");

  const intro = node("section", "dashboard-intro");
  const introCopy = node("div", "intro-copy");
  introCopy.append(node("p", "eyebrow", "Your image workspace"));
  const title = node("h1", "");
  title.append(
    node("span", "", "Imgbot"),
    document.createElement("br"),
    node("span", "headline-accent", "installations"),
  );
  introCopy.append(title);
  introCopy.append(
    node(
      "p",
      "intro-subtitle",
      "Choose what Imgbot watches, then let your pull requests do the talking.",
    ),
  );
  const introDecoration = node("div", "intro-decoration");
  introDecoration.append(
    node("span", "decoration-orbit orbit-one"),
    node("span", "decoration-orbit orbit-two"),
    node("span", "decoration-spark", "✳"),
  );
  intro.append(introCopy, introDecoration);
  main.append(intro);

  if (state.repoError) {
    const alert = node("section", "inline-error");
    alert.setAttribute("role", "alert");
    alert.append(
      node("span", "error-mark", "!"),
      node(
        "span",
        "inline-error-copy",
        `Your repositories could not be loaded. ${state.repoError}`,
      ),
    );
    alert.append(
      button("Retry", "button button-small button-outline", refreshRepos),
    );
    main.append(alert);
  } else if (state.repos.length === 0) {
    main.append(renderEmpty());
  } else {
    main.append(renderOverview());
    main.append(renderInstallationFilters());
    main.append(renderRepoSection());
  }
  shell.append(main);
  const footer = node("footer", "app-footer");
  footer.append(node("span", "", "Thoughtful image optimization for GitHub."));
  shell.append(footer);
  if (state.modalRepo) {
    const repo = state.repos.find((item) => item.fullName === state.modalRepo);
    if (repo) shell.append(renderSettingsDialog(repo));
  }
  app.append(shell);
  if (state.modalRepo) {
    const dialog = app.querySelector("dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }
}

function installations() {
  const groups = new Map();
  state.repos.forEach((repo) => {
    const [owner] = repo.fullName.split("/");
    if (!groups.has(repo.installationId))
      groups.set(repo.installationId, new Set());
    groups.get(repo.installationId).add(owner);
  });
  return [...groups.entries()].map(([id, owners]) => ({
    id: String(id),
    login: [...owners].sort((a, b) => a.localeCompare(b)).join(", "),
  }));
}

function renderInstallationFilters() {
  const section = node("nav", "installation-filters");
  section.setAttribute("aria-label", "Filter repositories by installation");
  const label = node("span", "filter-label", "Installations");
  const chips = node("div", "filter-chips");
  const all = button(
    "All",
    `filter-chip${state.installationFilter === "all" ? " active" : ""}`,
    () => {
      state.installationFilter = "all";
      render();
    },
  );
  all.setAttribute("aria-pressed", String(state.installationFilter === "all"));
  chips.append(all);
  installations().forEach((installation) => {
    const chip = button(
      installation.login,
      `filter-chip${state.installationFilter === installation.id ? " active" : ""}`,
      () => {
        state.installationFilter = installation.id;
        render();
      },
    );
    chip.setAttribute(
      "aria-pressed",
      String(state.installationFilter === installation.id),
    );
    chips.append(chip);
  });
  section.append(label, chips);
  return section;
}

function renderOverview() {
  const enabled = state.repos.filter((repo) => repo.enabled).length;
  const saved = state.repos.reduce(
    (sum, repo) => sum + (Number(repo.totalSavedBytes) || 0),
    0,
  );
  const strip = node("section", "overview-strip");
  strip.setAttribute("aria-label", "Repository overview");
  const cells = [
    {
      label: "Connected repositories",
      value: String(state.repos.length).padStart(2, "0"),
      note: "ready for image care",
      marker: "01",
    },
    {
      label: "Optimization active",
      value: `${String(enabled).padStart(2, "0")} / ${String(state.repos.length).padStart(2, "0")}`,
      note: "repositories enabled",
      marker: "02",
    },
    {
      label: "Space saved so far",
      value: formatBytes(saved),
      note: "across all repositories",
      marker: "03",
    },
  ];
  cells.forEach((item, index) => {
    const cell = node(
      "div",
      `overview-cell${index === 2 ? " overview-highlight" : ""}`,
    );
    cell.append(node("span", "overview-marker", item.marker));
    cell.append(node("p", "overview-label", item.label));
    cell.append(node("strong", "overview-value", item.value));
    cell.append(node("span", "overview-note", item.note));
    strip.append(cell);
  });
  return strip;
}

function renderRepoSection() {
  const section = node("section", "repo-section");
  const repos =
    state.installationFilter === "all"
      ? state.repos
      : state.repos.filter(
          (repo) => String(repo.installationId) === state.installationFilter,
        );
  const heading = node("div", "section-heading");
  const title = node("div", "");
  title.append(node("p", "eyebrow", "Connected to your account"));
  title.append(node("h2", "", "Repositories"));
  heading.append(
    title,
    node(
      "span",
      "repo-count",
      `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`,
    ),
  );
  section.append(heading);
  const list = node("div", "repo-list");
  repos.forEach((repo) => list.append(renderRepo(repo)));
  section.append(list);
  return section;
}

function renderRepo(repo) {
  const card = node("article", "repo-card");
  card.dataset.repo = repo.fullName;
  const top = node("div", "repo-top");
  const nameBlock = node("div", "repo-name-block");
  const icon = node(
    "span",
    "repo-icon",
    repo.fullName.split("/").at(-1)?.slice(0, 1).toUpperCase() || "R",
  );
  icon.setAttribute("aria-hidden", "true");
  const nameText = node("div", "repo-title-wrap");
  const name = node("h3", "repo-name", repo.fullName);
  nameText.append(name);
  const badges = node("div", "repo-badges");
  if (repo.isPrivate) badges.append(node("span", "private-badge", "Private"));
  else badges.append(node("span", "public-badge", "Public"));
  nameText.append(badges);
  nameBlock.append(icon, nameText);

  const toggle = node(
    "label",
    `toggle-control${state.savingSettings.has(repo.fullName) ? " is-busy" : ""}`,
  );
  const toggleLabel = repo.enabled
    ? "Request to remove this repository from optimization"
    : "Request to include this repository for optimization";
  toggle.title = state.savingSettings.has(repo.fullName)
    ? "Saving repository setting"
    : toggleLabel;
  const checkbox = node("input", "toggle-input");
  checkbox.type = "checkbox";
  checkbox.checked = Boolean(repo.enabled);
  checkbox.disabled = state.savingSettings.has(repo.fullName);
  checkbox.setAttribute("aria-label", `${toggleLabel} for ${repo.fullName}`);
  checkbox.addEventListener("change", () =>
    updateEnabled(repo, checkbox.checked),
  );
  const track = node("span", "toggle-track");
  track.setAttribute("aria-hidden", "true");
  toggle.append(
    checkbox,
    track,
    node("span", "toggle-label", repo.enabled ? "On" : "Off"),
  );
  top.append(nameBlock, toggle);
  card.append(top);

  const metrics = node("div", "repo-metrics");
  const lastRun = node("div", "repo-metric");
  lastRun.append(node("span", "metric-label", "Last checked"));
  const lastRunValue = node("div", "metric-value");
  if (!repo.enabled) {
    lastRunValue.append(
      node(
        "span",
        "last-run-copy",
        "This repository is not selected for optimization",
      ),
    );
    if (repo.lastRunState) {
      lastRunValue.append(
        node(
          "span",
          `status-pill ${stateClass(repo.lastRunState)}`,
          formatState(repo.lastRunState),
        ),
      );
    }
  } else if (repo.lastRunAt) {
    const lastRunCopy = node(
      "span",
      "last-run-copy",
      `The last optimization request was sent ${relativeDate(repo.lastRunAt)}`,
    );
    lastRunCopy.title = formatDate(repo.lastRunAt);
    lastRunValue.append(lastRunCopy);
    if (repo.lastRunState) {
      lastRunValue.append(
        node(
          "span",
          `status-pill ${stateClass(repo.lastRunState)}`,
          formatState(repo.lastRunState),
        ),
      );
    }
  } else {
    lastRunValue.append(
      node("span", "last-run-copy", "No optimization started recently"),
    );
  }
  lastRun.append(lastRunValue);
  const saved = node("div", "repo-metric");
  saved.append(node("span", "metric-label", "Total saved"));
  saved.append(
    node(
      "strong",
      "metric-value metric-number",
      formatBytes(repo.totalSavedBytes),
    ),
  );
  const pullRequests = node("div", "repo-metric");
  pullRequests.append(node("span", "metric-label", "Pull requests"));
  pullRequests.append(
    node("strong", "metric-value metric-number", String(repo.prCount ?? 0)),
  );
  metrics.append(lastRun, saved, pullRequests);
  card.append(metrics);

  const controls = node("div", "repo-controls");
  const actions = node("div", "repo-actions");
  const stats = state.stats.get(repo.fullName);
  const detailButton = button(
    stats?.open ? "Hide run history" : "View run history",
    "button button-detail",
    () => toggleStats(repo),
  );
  detailButton.setAttribute("aria-expanded", String(Boolean(stats?.open)));
  const chevron = node("span", `chevron${stats?.open ? " is-open" : ""}`, "⌄");
  chevron.setAttribute("aria-hidden", "true");
  detailButton.append(chevron);
  const settingsButton = button(
    "Settings",
    "button button-detail settings-button",
    () => openSettings(repo),
  );
  const optimizing = state.optimizing.has(repo.fullName);
  const optimizeButton = button(
    optimizing ? "Requesting ..." : "Request new optimization",
    "button button-primary optimize-button",
    () => requestOptimization(repo),
    optimizing,
  );
  actions.append(settingsButton, detailButton, optimizeButton);
  controls.append(actions);
  card.append(controls);

  const notice = state.repoNotices.get(repo.fullName);
  if (notice) {
    const noticeEl = node("p", `repo-notice ${notice.kind}`, notice.message);
    noticeEl.setAttribute("role", notice.kind === "error" ? "alert" : "status");
    card.append(noticeEl);
  }
  if (stats?.open) card.append(renderStats(repo, stats));
  return card;
}

function renderSettingsDialog(repo) {
  const dialog = node("dialog", "settings-dialog");
  dialog.setAttribute("aria-labelledby", "settings-title");
  dialog.addEventListener("cancel", () => {
    state.modalRepo = null;
    state.modalError = "";
  });
  const header = node("div", "settings-header");
  const title = node(
    "h2",
    "",
    `Settings for "${repo.fullName.split("/").at(-1)}"`,
  );
  title.id = "settings-title";
  const close = button("×", "dialog-close", () => {
    dialog.close();
    state.modalRepo = null;
    state.modalError = "";
  });
  close.setAttribute("aria-label", "Close settings");
  header.append(title, close);

  const body = node("div", "settings-body");
  const label = node("label", "settings-label", "Default branch override:");
  label.htmlFor = "settings-branch";
  const input = node("input", "branch-input settings-input");
  input.type = "text";
  input.id = "settings-branch";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "(optional)";
  input.value = state.branchDrafts.has(repo.fullName)
    ? state.branchDrafts.get(repo.fullName)
    : repo.defaultBranchOverride || "";
  input.addEventListener("input", () =>
    state.branchDrafts.set(repo.fullName, input.value),
  );
  const busy = state.savingSettings.has(`${repo.fullName}:branch`);
  const helper = node(
    "p",
    "settings-helper",
    "If you want Imgbot to look after a different branch instead of the default for the repo.",
  );
  body.append(label, input, helper);
  if (state.modalError) {
    const error = node("p", "settings-error", state.modalError);
    error.setAttribute("role", "alert");
    body.append(error);
  }

  const footer = node("div", "settings-footer");
  const clear = button(
    "Clear override",
    "text-button clear-override",
    () => clearBranchSetting(repo),
    busy,
  );
  const cancel = button("Cancel", "button button-outline", () => {
    dialog.close();
    state.modalRepo = null;
    state.modalError = "";
    render();
  });
  const save = button(
    busy ? "Saving…" : "Save changes",
    "button button-primary",
    () => saveBranchSetting(repo),
    busy,
  );
  footer.append(clear, cancel, save);
  dialog.append(header, body, footer);
  return dialog;
}

function openSettings(repo) {
  state.modalRepo = repo.fullName;
  state.modalError = "";
  render();
}

function renderStats(repo, stats) {
  const panel = node("section", "stats-panel");
  panel.setAttribute("aria-label", `Run history for ${repo.fullName}`);
  const heading = node("div", "stats-heading");
  heading.append(node("div", "stats-heading-title", "Optimization history"));
  heading.append(node("span", "stats-caption", "A closer look at the work"));
  panel.append(heading);
  if (stats.loading) {
    const loading = node("div", "stats-loading");
    loading.append(
      node("span", "loader loader-small"),
      node("span", "", "Loading repository stats…"),
    );
    panel.append(loading);
    return panel;
  }
  if (stats.error) {
    const err = node("div", "stats-error");
    err.setAttribute("role", "alert");
    err.append(
      node("span", "", stats.error),
      button("Retry", "text-button", () => loadStats(repo)),
    );
    panel.append(err);
    return panel;
  }
  if (!stats.data) return panel;

  const data = stats.data;
  const totals = node("div", "stats-totals");
  [
    ["Before", formatBytes(data.totals?.bytesBefore)],
    ["After", formatBytes(data.totals?.bytesAfter)],
    ["Saved", `${Number(data.totals?.savedKb || 0).toLocaleString()} KB`],
    ["Runs", String(data.totals?.runs ?? 0)],
  ].forEach(([label, value]) => {
    const item = node("div", "stats-total");
    item.append(node("span", "metric-label", label), node("strong", "", value));
    totals.append(item);
  });
  panel.append(totals);
  panel.append(renderRecentRuns(repo, data.recentRuns || []));
  panel.append(renderPulls(repo, data.pulls || []));
  return panel;
}

function githubLink(repoName, number) {
  const link = node("a", "github-link", `#${number}`);
  link.href = githubPullUrl(repoName, number);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `Pull request ${number} on GitHub`);
  return link;
}

function renderRecentRuns(repo, runs) {
  const section = node("div", "history-section");
  const heading = node("h4", "", "Recent runs");
  section.append(heading);
  if (runs.length === 0) {
    section.append(
      node("p", "history-empty", "No optimization runs to show yet."),
    );
    return section;
  }
  const wrap = node("div", "table-scroll");
  const table = node("table", "history-table");
  const thead = node("thead");
  const headerRow = node("tr");
  ["State", "Trigger", "Images", "Saved", "Created", "PR"].forEach((label) =>
    headerRow.append(node("th", "", label)),
  );
  thead.append(headerRow);
  const tbody = node("tbody");
  runs.forEach((run) => {
    const row = node("tr");
    row.append(node("td", "", formatState(run.state)));
    row.append(node("td", "muted", run.trigger || "—"));
    row.append(
      node(
        "td",
        "",
        run.imagesOptimized == null ? "—" : String(run.imagesOptimized),
      ),
    );
    row.append(
      node("td", "", `${Number(run.savedKb || 0).toLocaleString()} KB`),
    );
    const created = node("td");
    created.append(dateText(run.createdAt));
    row.append(created);
    const pr = node("td");
    if (run.prNumber != null)
      pr.append(githubLink(repo.fullName, run.prNumber));
    else pr.append(node("span", "muted", "—"));
    row.append(pr);
    tbody.append(row);
  });
  table.append(thead, tbody);
  wrap.append(table);
  section.append(wrap);
  return section;
}

function renderPulls(repo, pulls) {
  const section = node("div", "history-section pulls-section");
  const heading = node("h4", "", "Pull requests");
  section.append(heading);
  if (pulls.length === 0) {
    section.append(node("p", "history-empty", "No pull requests yet."));
    return section;
  }
  const list = node("ul", "pull-list");
  pulls.forEach((pull) => {
    const item = node("li", "pull-item");
    const summary = node("div", "pull-summary");
    summary.append(githubLink(repo.fullName, pull.prNumber));
    summary.append(
      node(
        "span",
        `pull-state ${stateClass(pull.state)}`,
        formatState(pull.state),
      ),
    );
    item.append(summary);
    const dates = node("div", "pull-dates");
    dates.append(node("span", "", `Opened ${formatDate(pull.openedAt)}`));
    if (pull.closedAt)
      dates.append(node("span", "", `Closed ${formatDate(pull.closedAt)}`));
    item.append(dates);
    list.append(item);
  });
  section.append(list);
  return section;
}

function renderEmpty() {
  const empty = node("section", "empty-state");
  const art = node("div", "empty-art");
  art.append(
    node("span", "empty-art-ring ring-a"),
    node("span", "empty-art-ring ring-b"),
    node("span", "empty-art-spark", "✳"),
  );
  empty.append(art);
  empty.append(node("p", "eyebrow", "Your image workspace"));
  empty.append(node("h2", "", "No installations found"));
  empty.append(
    node(
      "p",
      "empty-copy",
      "Install Imgbot on a GitHub account or organization to see its repositories.",
    ),
  );
  const link = node("a", "button button-primary", "Install now");
  link.href = state.installUrl || "https://github.com/settings/installations";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  empty.append(link);
  return empty;
}

async function signOut(event) {
  const target = event?.currentTarget;
  if (target) {
    markBusy(target, "Signing out…");
    target.disabled = true;
  }
  try {
    // 后端 logout 只收 POST（CSRF 基线，tests/auth.test.ts 锁定）。
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // 请求失败也照常回到干净的登录页。
  }
  window.location.reload();
}

async function refreshRepos() {
  state.repoError = "";
  render();
  try {
    state.repos = await api("/api/repos");
  } catch (error) {
    if (!handleUnauthorized(error)) state.repoError = error.message;
  }
  render();
}

async function updateEnabled(repo, enabled) {
  const key = repo.fullName;
  state.savingSettings.add(key);
  state.repoNotices.delete(key);
  render();
  try {
    const result = await api(repoPath(key, "settings"), {
      method: "POST",
      body: JSON.stringify({ enabled }),
    });
    repo.enabled = result.enabled;
    state.repoNotices.set(key, {
      kind: "success",
      message: `Optimization ${result.enabled ? "enabled" : "paused"} for ${key}.`,
    });
  } catch (error) {
    if (!handleUnauthorized(error))
      state.repoNotices.set(key, { kind: "error", message: error.message });
  } finally {
    state.savingSettings.delete(key);
    render();
  }
}

async function saveBranchSetting(repo) {
  const key = repo.fullName;
  const busyKey = `${key}:branch`;
  const draft = (state.branchDrafts.get(key) || "").trim();
  state.savingSettings.add(busyKey);
  state.modalError = "";
  state.repoNotices.delete(key);
  render();
  try {
    const result = await api(repoPath(key, "settings"), {
      method: "POST",
      body: JSON.stringify({ defaultBranchOverride: draft || null }),
    });
    state.branchDrafts.set(key, result.defaultBranchOverride || "");
    state.repoNotices.set(key, {
      kind: "success",
      message: result.defaultBranchOverride
        ? `Default branch override saved as “${result.defaultBranchOverride}”.`
        : "Branch override cleared. The repository default will be used.",
    });
    state.modalRepo = null;
  } catch (error) {
    state.modalError = error.message;
    if (handleUnauthorized(error)) state.modalError = "";
    else state.repoNotices.set(key, { kind: "error", message: error.message });
  } finally {
    state.savingSettings.delete(busyKey);
    render();
  }
}

async function clearBranchSetting(repo) {
  state.branchDrafts.set(repo.fullName, "");
  await saveBranchSetting(repo);
}

async function requestOptimization(repo) {
  const key = repo.fullName;
  state.optimizing.add(key);
  state.repoNotices.delete(key);
  render();
  try {
    const result = await api(repoPath(key, "optimize"), { method: "POST" });
    if (result.coalesced) {
      state.repoNotices.set(key, {
        kind: "info",
        message:
          "An optimization is already in progress for this repository. Your request was grouped with it.",
      });
    } else if (result.started) {
      state.repoNotices.set(key, {
        kind: "success",
        message:
          "Optimization queued. We’ll update this repository when it’s ready.",
      });
    } else {
      state.repoNotices.set(key, {
        kind: "info",
        message: "Your optimization request was received.",
      });
    }
  } catch (error) {
    if (!handleUnauthorized(error))
      state.repoNotices.set(key, { kind: "error", message: error.message });
  } finally {
    state.optimizing.delete(key);
    render();
  }
}

async function toggleStats(repo) {
  const current = state.stats.get(repo.fullName) || {
    open: false,
    loading: false,
    data: null,
    error: "",
  };
  current.open = !current.open;
  state.stats.set(repo.fullName, current);
  render();
  if (current.open && !current.data && !current.loading) await loadStats(repo);
}

async function loadStats(repo) {
  const current = state.stats.get(repo.fullName) || {
    open: true,
    loading: false,
    data: null,
    error: "",
  };
  current.open = true;
  current.loading = true;
  current.error = "";
  state.stats.set(repo.fullName, current);
  render();
  try {
    current.data = await api(repoPath(repo.fullName, "stats"));
  } catch (error) {
    if (handleUnauthorized(error)) current.open = false;
    else current.error = error.message;
  } finally {
    current.loading = false;
    state.stats.set(repo.fullName, current);
    render();
  }
}

loadWorkspace();
