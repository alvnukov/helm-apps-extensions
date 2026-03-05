const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const extRoot = path.resolve(__dirname, "..");
const dst = path.join(extRoot, "assets", "helm-apps");
const pinnedRefFile = path.join(extRoot, "helm-apps.bundle-ref");
const repo = process.env.HELM_APPS_GITHUB_REPO || "https://github.com/alvnukov/helm-apps.git";
const pinnedRef = fs.existsSync(pinnedRefFile)
  ? fs.readFileSync(pinnedRefFile, "utf8").trim()
  : "";
const ref = (process.env.HELM_APPS_GITHUB_REF || pinnedRef).trim();

if (!ref) {
  throw new Error(
    "helm-apps bundle ref is empty. Set HELM_APPS_GITHUB_REF or fill helm-apps.bundle-ref in extension repo.",
  );
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  for (const name of fs.readdirSync(p)) {
    const full = path.join(p, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      rmrf(full);
    } else {
      fs.unlinkSync(full);
    }
  }
  fs.rmdirSync(p);
}

function cpdir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const s = path.join(from, name);
    const d = path.join(to, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      cpdir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "helm-apps-sync-"));
const repoDir = path.join(checkout, "repo");
try {
  childProcess.execFileSync("git", ["clone", "--depth", "1", "--branch", ref, repo, repoDir], { stdio: "inherit" });
  const src = path.join(repoDir, "charts", "helm-apps");
  if (!fs.existsSync(path.join(src, "Chart.yaml"))) {
    throw new Error(`source chart not found in cloned repo: ${src}`);
  }
  rmrf(dst);
  cpdir(src, dst);
  // eslint-disable-next-line no-console
  console.log(`synced bundled helm-apps chart from ${repo}@${ref}: ${dst}`);
} finally {
  rmrf(checkout);
}
