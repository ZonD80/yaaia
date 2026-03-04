import { join, dirname } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import archiver from "archiver";
import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const HIDE_RESULT_TOOLS = new Set([
  "take_screenshot",
  "take_snapshot",
  "secrets_list",
  "secrets_get",
]);

export interface RecipeEntry {
  toolName: string;
  assessment: string;
  clarification: string;
  result: string;
  params?: Record<string, unknown>;
  screenshotBase64?: string;
  vision?: string;
  terminalBase64?: string;
  click?: { x: number; y: number; element?: string };
}

export interface UserInjection {
  text: string;
  afterStepIndex: number;
}

export interface RecipeState {
  taskSummary: string;
  initialPrompt: string;
  goalAssessment?: string;
  model: string;
  startedAt: number;
  finalizedAt: number | null;
  isSuccess: boolean | null;
  finalAssessment?: string;
  detailedReport?: string;
  entries: RecipeEntry[];
  userInjections: UserInjection[];
}

let pendingInitialPrompt = "";
let currentModel = "";
let recipe: RecipeState | null = null;

export interface FinalizeTaskPopupInfo {
  assessment: string;
  clarification: string;
  is_successful: boolean;
  detailed_report: string;
}

let pendingFinalizeInfo: { assessment: string; clarification: string; is_successful: boolean } | null = null;

export function setInitialPrompt(msg: string): void {
  pendingInitialPrompt = String(msg ?? "").trim();
}

export function setModel(model: string): void {
  currentModel = String(model ?? "").trim();
}

function ensureRecipe(summary = "Task"): void {
  if (!recipe) {
    recipe = {
      taskSummary: summary,
      initialPrompt: pendingInitialPrompt,
      model: currentModel,
      startedAt: Date.now(),
      finalizedAt: null,
      isSuccess: null,
      entries: [],
      userInjections: [],
    } as RecipeState;
  }
}

export function initFromStartTask(summary: string, assessment?: string): void {
  pendingFinalizeInfo = null;
  recipe = {
    taskSummary: String(summary ?? "").trim(),
    initialPrompt: pendingInitialPrompt,
    goalAssessment: (typeof assessment === "string" ? assessment : "")?.trim() || undefined,
    model: currentModel,
    startedAt: Date.now(),
    finalizedAt: null,
    isSuccess: null,
    entries: [],
    userInjections: [],
  } as RecipeState;
}

function paramsFromArgs(args: unknown): Record<string, unknown> | undefined {
  const a = args as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (k === "assessment" || k === "clarification") continue;
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function appendToolCall(
  toolName: string,
  args: unknown,
  resultText: string,
  extra?: { screenshotBase64?: string; vision?: string; terminalBase64?: string; click?: { x: number; y: number; element?: string } }
): void {
  ensureRecipe();
  if (!recipe) return;
  const a = args as Record<string, unknown> | undefined;
  const assessment = (typeof a?.assessment === "string" ? a.assessment : "")?.trim() ?? "";
  const clarification = (typeof a?.clarification === "string" ? a.clarification : "")?.trim() ?? "";
  recipe.entries.push({
    toolName,
    assessment,
    clarification,
    result: String(resultText ?? "").trim(),
    params: paramsFromArgs(args),
    ...extra,
  });
}

export function appendUserInjection(text: string, placeAfterNextStep = false): void {
  ensureRecipe();
  if (!recipe) return;
  const afterStepIndex = placeAfterNextStep ? recipe.entries.length + 1 : recipe.entries.length;
  recipe.userInjections.push({ text: String(text ?? "").trim(), afterStepIndex });
}

export function finalize(isSuccess: boolean, assessment = "", clarification = ""): void {
  ensureRecipe();
  if (!recipe) return;
  recipe.finalizedAt = Date.now();
  recipe.isSuccess = isSuccess;
  recipe.finalAssessment = (typeof assessment === "string" ? assessment : "")?.trim() || undefined;
  pendingFinalizeInfo = {
    assessment: (typeof assessment === "string" ? assessment : "")?.trim() ?? "",
    clarification: (typeof clarification === "string" ? clarification : "")?.trim() ?? "",
    is_successful: isSuccess,
  };
}

export function clearPendingFinalize(): void {
  pendingFinalizeInfo = null;
}

export function completeFinalizeWithReport(report: string): FinalizeTaskPopupInfo | null {
  const info = pendingFinalizeInfo;
  pendingFinalizeInfo = null;
  if (!info || !recipe) return null;
  const detailedReport = (typeof report === "string" ? report : "")?.trim() ?? "";
  recipe.detailedReport = detailedReport || undefined;
  return {
    assessment: info.assessment,
    clarification: info.clarification,
    is_successful: info.is_successful,
    detailed_report: detailedReport,
  };
}

export function getRecipe(): RecipeState | null {
  return recipe;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function truncate(s: string, max = 500): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max) + "...";
}

function formatParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${val.length > 80 ? val.slice(0, 80) + "…" : val}`;
    })
    .join(", ");
}

function mdBlock(s: string): string {
  const t = String(s ?? "").trim();
  return t ? `~~~\n${t}\n~~~` : "";
}

export function generateMarkdown(): string {
  const r = recipe;
  if (!r) {
    return "# Recipe\n\nNo recipe yet. Start a task to build a recipe.";
  }

  const resultBadge =
    r.isSuccess === null ? "" : r.isSuccess ? "✓ Done" : "✗ Failed";
  const duration =
    r.finalizedAt != null ? formatDuration(r.finalizedAt - r.startedAt) : formatDuration(Date.now() - r.startedAt);

  function renderEntry(e: RecipeEntry, num: number): string {
    let imgMd = "";
    if (e.screenshotBase64 || e.terminalBase64) {
      imgMd = `\n![Screenshot](entry-${num}.png)\n`;
    }
    const clickMd = e.click ? `\n**click:** [${e.click.x}, ${e.click.y}]${e.click.element ? ` (element: "${e.click.element}")` : ""}\n` : "";
    const visionMd = e.vision ? `\n**Vision:**\n${mdBlock(e.vision)}\n` : "";
    const paramsMd =
      e.params && Object.keys(e.params).length > 0
        ? `\n**Params:** ${formatParams(e.params)}\n`
        : "";
    const hideResult = HIDE_RESULT_TOOLS.has(e.toolName);
    const resultMd = hideResult ? "" : `\n**Result:**\n${mdBlock(truncate(e.result, 2000))}\n`;
    return `
### ${num}. ${e.toolName}

**Assessment:** ${e.assessment || "(none)"}
**Clarification:** ${e.clarification || "(none)"}
${paramsMd}${imgMd}${clickMd}${visionMd}${resultMd}`;
  }

  const stepsParts: string[] = [];
  const injectionsBeforeFirst = r.userInjections.filter((u) => u.afterStepIndex === 0);
  for (const inj of injectionsBeforeFirst) {
    if (inj.text) stepsParts.push(`> **User said:** ${inj.text}\n`);
  }
  for (let i = 0; i < r.entries.length; i++) {
    stepsParts.push(renderEntry(r.entries[i], i + 1));
    const injectionsAfterStep = r.userInjections.filter((u) => u.afterStepIndex === i + 1);
    for (const inj of injectionsAfterStep) {
      if (inj.text) stepsParts.push(`> **User said:** ${inj.text}\n`);
    }
  }
  const trailingInjections = r.userInjections.filter((u) => u.afterStepIndex > r.entries.length);
  for (const inj of trailingInjections) {
    if (inj.text) stepsParts.push(`> **User said:** ${inj.text}\n`);
  }
  const stepsMd = stepsParts.join("");

  const finalAssessmentMd =
    r.finalizedAt != null && r.finalAssessment
      ? `\n## Final assessment\n\n${mdBlock(r.finalAssessment)}\n`
      : "";
  const detailedReportMd =
    r.detailedReport
      ? `\n## Detailed report\n\n${mdBlock(r.detailedReport)}\n`
      : "";

  return `# Recipe: ${r.taskSummary}

**Model:** ${r.model || "(unknown)"} | **Started:** ${new Date(r.startedAt).toLocaleString()} | **Duration:** ${duration}${resultBadge ? ` | **Result:** ${resultBadge}` : ""}

## Goal

${r.initialPrompt || "(No initial prompt)"}
${r.goalAssessment ? `\n**Assessment:** ${r.goalAssessment}` : ""}

## Steps

${stepsMd}${finalAssessmentMd}${detailedReportMd}`;
}

export function generateHtml(embedImages = true): string {
  const r = recipe;
  if (!r) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Recipe</title></head>
<body><p>No recipe yet. Start a task to build a recipe.</p></body></html>`;
  }

  const resultBadge =
    r.isSuccess === null
      ? ""
      : r.isSuccess
        ? '<span style="color:#2ea043">✓ Done</span>'
        : '<span style="color:#f85149">✗ Failed</span>';
  const finalAssessmentHtml =
    r.finalizedAt != null && r.finalAssessment
      ? `<div class="final-assessment" style="color:${r.isSuccess ? "#2ea043" : "#f85149"};margin-top:1.5rem;padding:1rem;border-radius:6px;border:1px solid ${r.isSuccess ? "#238636" : "#da3633"};background:${r.isSuccess ? "rgba(46,160,67,0.1)" : "rgba(248,81,73,0.1)"}"><strong>Final assessment:</strong> ${escapeHtml(r.finalAssessment)}</div>`
      : "";
  const detailedReportHtml =
    r.detailedReport
      ? `<div class="detailed-report" style="margin-top:1.5rem;padding:1rem;border-radius:6px;border:1px solid #30363d;background:#161b22"><strong>Detailed report:</strong><pre style="white-space:pre-wrap;word-break:break-word;margin-top:0.5rem">${escapeHtml(r.detailedReport)}</pre></div>`
      : "";
  const duration =
    r.finalizedAt != null ? formatDuration(r.finalizedAt - r.startedAt) : formatDuration(Date.now() - r.startedAt);

  function renderEntry(e: RecipeEntry, num: number): string {
    let imgHtml = "";
    if (e.screenshotBase64) {
      const src = embedImages ? `data:image/png;base64,${e.screenshotBase64}` : `entry-${num}.png`;
      imgHtml = `<div class="screenshot"><img src="${src}" alt="Screenshot" style="max-width:100%;height:auto;border:1px solid #333;border-radius:6px;object-fit:contain"/></div>`;
    } else if (e.terminalBase64) {
      const src = embedImages ? `data:image/png;base64,${e.terminalBase64}` : `entry-${num}.png`;
      imgHtml = `<div class="screenshot"><img src="${src}" alt="Terminal" style="max-width:100%;height:auto;border:1px solid #333;border-radius:6px;object-fit:contain"/></div>`;
    }
    const clickHtml = e.click ? `<p><strong>click:</strong> [${e.click.x}, ${e.click.y}]${e.click.element ? ` (element: "${escapeHtml(e.click.element)}")` : ""}</p>` : "";
    const visionHtml = e.vision ? `<p><strong>Vision:</strong> ${escapeHtml(e.vision)}</p>` : "";
    const paramsHtml =
      e.params && Object.keys(e.params).length > 0
        ? `<p><strong>Params:</strong> ${escapeHtml(formatParams(e.params))}</p>`
        : "";
    const hideResult = HIDE_RESULT_TOOLS.has(e.toolName);
    const resultHtml = hideResult ? "" : `<p><strong>Result:</strong> <pre class="result">${escapeHtml(truncate(e.result, 2000))}</pre></p>`;
    return `
<div class="entry">
  <h3>${num}. ${escapeHtml(e.toolName)}</h3>
  <p><strong>Assessment:</strong> ${escapeHtml(e.assessment || "(none)")}</p>
  <p><strong>Clarification:</strong> ${escapeHtml(e.clarification || "(none)")}</p>
  ${paramsHtml}
  ${imgHtml}
  ${clickHtml}
  ${visionHtml}
  ${resultHtml}
</div>`;
  }

  const stepsParts: string[] = [];
  const injectionsBeforeFirst = r.userInjections.filter((u) => u.afterStepIndex === 0);
  for (const inj of injectionsBeforeFirst) {
    if (inj.text) stepsParts.push(`<div class="user-injection"><strong>User said:</strong> ${escapeHtml(inj.text)}</div>`);
  }
  for (let i = 0; i < r.entries.length; i++) {
    stepsParts.push(renderEntry(r.entries[i], i + 1));
    const injectionsAfterStep = r.userInjections.filter((u) => u.afterStepIndex === i + 1);
    for (const inj of injectionsAfterStep) {
      if (inj.text) stepsParts.push(`<div class="user-injection"><strong>User said:</strong> ${escapeHtml(inj.text)}</div>`);
    }
  }
  const trailingInjections = r.userInjections.filter((u) => u.afterStepIndex > r.entries.length);
  for (const inj of trailingInjections) {
    if (inj.text) stepsParts.push(`<div class="user-injection"><strong>User said:</strong> ${escapeHtml(inj.text)}</div>`);
  }
  const stepsHtml = stepsParts.join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Recipe: ${escapeHtml(r.taskSummary)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; background: #0d1117; color: #e6edf3; line-height: 1.6; }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    .meta { color: #8b949e; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .section { margin-bottom: 2rem; }
    .entry { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; overflow: hidden; }
    .entry h3 { margin-top: 0; margin-bottom: 0.75rem; font-size: 1rem; color: #58a6ff; }
    .screenshot { margin: 0.75rem 0; overflow: hidden; }
    .screenshot img { max-width: 100%; width: auto; height: auto; object-fit: contain; display: block; }
    .result { background: #21262d; padding: 0.5rem; border-radius: 4px; font-size: 0.85rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
    .user-injection { background: #21262d; border-left: 4px solid #58a6ff; padding: 0.75rem 1rem; margin-bottom: 1rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Recipe: ${escapeHtml(r.taskSummary)}</h1>
  <div class="meta">
    <span>Model: ${escapeHtml(r.model || "(unknown)")}</span>
    <span>Started: ${new Date(r.startedAt).toLocaleString()}</span>
    <span>Duration: ${duration}</span>
    ${resultBadge ? `<span>Result: ${resultBadge}</span>` : ""}
  </div>

  <div class="section">
    <h2>Goal</h2>
    <p>${escapeHtml(r.initialPrompt || "(No initial prompt)")}</p>
    ${r.goalAssessment ? `<p><strong>Assessment:</strong> ${escapeHtml(r.goalAssessment)}</p>` : ""}
  </div>

  <h2>Steps</h2>
  ${stepsHtml}
  ${finalAssessmentHtml}
  ${detailedReportHtml}

</body>
</html>`;
}

function getMarkedUmdBuffer(): Buffer {
  const markedPkgPath = require.resolve("marked/package.json");
  const markedDir = dirname(markedPkgPath);
  const markedPath = join(markedDir, "lib/marked.umd.js");
  return readFileSync(markedPath);
}

export function generateRecipeIndexHtml(md: string): string {
  const escapedMd = JSON.stringify(md);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Recipe</title>
  <script src="marked.js"></script>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; background: #0d1117; color: #e6edf3; line-height: 1.6; }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.2rem; margin-top: 1.5rem; }
    h3 { font-size: 1rem; color: #58a6ff; margin-top: 1rem; }
    .meta { color: #8b949e; font-size: 0.9rem; margin-bottom: 1.5rem; }
    pre { background: #21262d; padding: 0.5rem; border-radius: 4px; font-size: 0.85rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
    blockquote { background: #21262d; border-left: 4px solid #58a6ff; padding: 0.75rem 1rem; margin: 1rem 0; border-radius: 4px; }
    .screenshot img, #content img { max-width: 100%; height: auto; object-fit: contain; }
    #content { overflow: hidden; }
  </style>
</head>
<body>
  <div id="content"></div>
  <script type="application/json" id="recipe-md">${escapedMd}</script>
  <script>
    (function() {
      var fallbackMd = (function() {
        var el = document.getElementById('recipe-md');
        return el ? JSON.parse(el.textContent) : '';
      })();
      function render(md) {
        document.getElementById('content').innerHTML = marked.parse(md || '# No recipe');
      }
      render(fallbackMd);
      fetch('RECIPE.md').then(function(r) { return r.text(); }).then(render).catch(function() {});
    })();
  </script>
</body>
</html>`;
}

export async function saveRecipeToZip(targetPath: string): Promise<void> {
  const r = recipe;
  if (!r) throw new Error("No recipe to save");

  const md = generateMarkdown();
  const indexHtml = generateRecipeIndexHtml(md);

  const archive = archiver("zip", { zlib: { level: 9 } });
  const out = createWriteStream(targetPath);
  await new Promise<void>((resolve, reject) => {
    out.on("close", resolve);
    out.on("error", reject);
    archive.on("error", reject);
    archive.pipe(out);

    archive.append(indexHtml, { name: "index.html" });
    archive.append(md, { name: "RECIPE.md" });
    archive.append(getMarkedUmdBuffer(), { name: "marked.js" });

    r.entries.forEach((e, i) => {
      const base64 = e.screenshotBase64 ?? e.terminalBase64;
      if (base64) {
        archive.append(Buffer.from(base64, "base64"), { name: `entry-${i + 1}.png` });
      }
    });

    archive.finalize();
  });
}
