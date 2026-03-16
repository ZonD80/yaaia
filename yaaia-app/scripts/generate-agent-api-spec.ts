/**
 * Generate agent API spec from agent-api.ts (code as source of truth).
 * Fully declarative: paramsSchema (JSON Schema), returns, paramsType.
 * Output: agent-api-spec.generated.ts
 *
 * Run: npx tsx scripts/generate-agent-api-spec.ts
 */

import { Project, SyntaxKind } from "ts-morph";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const AGENT_API_PATH = join(ROOT, "electron/main/agent-api.ts");
const RETURN_SCHEMAS_PATH = join(ROOT, "electron/main/agent-api-return-schemas.ts");
const OUTPUT_PATH = join(ROOT, "electron/main/agent-api-spec.generated.ts");

export interface ToolSpec {
  name: string;
  description: string;
  params?: string;
  paramsType?: string;
  paramsSchema?: Record<string, unknown>;
  returns: string;
}

/** Parse JSDoc block into description and optional Params section. */
function parseJsDoc(jsdoc: string): { description: string; params?: string } {
  const trimmed = jsdoc
    .replace(/^\/\*\*/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^\s*\*\s?/gm, "")
    .trim();
  const paramsMatch = trimmed.match(/\bParams?:\s*(.+)$/s);
  let description: string;
  let params: string | undefined;
  if (paramsMatch) {
    description = trimmed.slice(0, paramsMatch.index).trim().replace(/\s+/g, " ");
    params = paramsMatch[1].trim().replace(/\s+/g, " ");
  } else {
    description = trimmed.replace(/\s+/g, " ");
    params = undefined;
  }
  description = (description || "Tool").replace(/^\/\*\*\s*/, "").replace(/\s*\*\/\s*$/, "");
  return { description: description || "Tool", params };
}

/** Get JSDoc comment immediately before a node from source text */
function getJsDocBeforeNode(sourceText: string, nodeStart: number): string | null {
  const before = sourceText.slice(0, nodeStart);
  const match = before.match(/\/\*\*[\s\S]*?\*\//g);
  return match ? match[match.length - 1]! : null;
}

/** Convert TS object type string to JSON Schema. Handles { key: type; key?: type }. */
function tsTypeToJsonSchema(typeStr: string): Record<string, unknown> | undefined {
  const trimmed = typeStr.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return { type: "object", properties: {}, required: [] };

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  // Match "key: type" or "key?: type" - type can contain ; or } so we need to be careful
  const propRe = /(\w+)(\??)\s*:\s*([^;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(inner)) !== null) {
    const [, key, opt, typePart] = m;
    if (!key) continue;
    const type = typePart.trim();
    let schema: Record<string, unknown>;
    if (type === "string") schema = { type: "string" };
    else if (type === "number") schema = { type: "number" };
    else if (type === "boolean") schema = { type: "boolean" };
    else if (type === "string[]") schema = { type: "array", items: { type: "string" } };
    else if (/^["']?\w+["']?\s*\|\s*["']?\w+["']?$/.test(type)) {
      const enumVals = type.split("|").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      schema = { type: "string", enum: enumVals };
    } else schema = { type: "string", description: type };
    properties[key] = schema;
    if (!opt) required.push(key);
  }
  return { type: "object", properties, required };
}

/** Load RETURN_SCHEMAS from agent-api-return-schemas.ts via ts-morph */
function loadReturnSchemas(): Record<string, string> {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sf = project.addSourceFileAtPath(RETURN_SCHEMAS_PATH);
  const varDecl = sf.getVariableDeclaration("RETURN_SCHEMAS");
  if (!varDecl) return {};
  const init = varDecl.getInitializer();
  if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) return {};
  const obj = init.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
  const out: Record<string, string> = {};
  for (const prop of obj.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const pa = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
    const name =
      pa.getNameNode().getKind() === SyntaxKind.StringLiteral
        ? pa.getNameNode().getLiteralText()
        : pa.getNameNode().getText();
    const val = pa.getInitializer();
    if (!val) continue;
    const kind = val.getKind();
    if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
      out[name] = (val as { getLiteralText(): string }).getLiteralText();
    } else {
      const text = val.getText();
      out[name] = text.replace(/^`|`$/g, "");
    }
  }
  return out;
}

const DEFAULT_RETURNS = "string — tool output (format varies)";

function extractToolSpecs(): ToolSpec[] {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sourceFile = project.addSourceFileAtPath(AGENT_API_PATH);
  const sourceText = sourceFile.getFullText();
  const returnSchemas = loadReturnSchemas();

  const specs: Map<string, ToolSpec> = new Map();

  // 1. Find all call("tool_name", args) and extract tool name + param type + JSDoc
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const call = node.asKindOrThrow(SyntaxKind.CallExpression);
    const expr = call.getExpression();
    const exprText = expr.getText();
    if (exprText !== "call") return;

    const args = call.getArguments();
    const firstArg = args[0];
    if (!firstArg) return;

    const toolName =
      firstArg.getKind() === SyntaxKind.StringLiteral
        ? firstArg.getLiteralText()
        : firstArg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
          ? firstArg.getLiteralText()
          : null;
    if (!toolName) return;

    let paramsStr: string | undefined;
    let propNode: ReturnType<typeof node.getParent> = null;

    // Find parent arrow function and property assignment
    let parent = node.getParent();
    while (parent) {
      const kind = parent.getKind();
      if (kind === SyntaxKind.ArrowFunction) {
        const arrow = parent.asKindOrThrow(SyntaxKind.ArrowFunction);
        const params = arrow.getParameters();
        const firstParam = params[0];
        if (firstParam) {
          const typeNode = firstParam.getTypeNode();
          if (typeNode) paramsStr = typeNode.getText();
        }
        propNode = parent.getParent();
        break;
      }
      parent = parent.getParent();
    }

    const jsdocRaw = propNode ? getJsDocBeforeNode(sourceText, propNode.getStart()) : null;
    const { description, params } = jsdocRaw ? parseJsDoc(jsdocRaw) : { description: `Tool ${toolName}`, params: undefined };

    const paramsSchema = paramsStr ? tsTypeToJsonSchema(paramsStr) : undefined;
    specs.set(toolName, {
      name: toolName,
      description,
      params: params ?? paramsStr,
      paramsType: paramsStr,
      paramsSchema,
      returns: returnSchemas[toolName] ?? DEFAULT_RETURNS,
    });
  });

  // 2. Find vm_serial (and other non-call tools) by traversing the return object
  extractNestedTools(sourceFile, sourceText, specs, returnSchemas);

  return [...specs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Extract tools from nested objects (e.g. vm_serial) that don't use call() */
function extractNestedTools(
  sourceFile: ReturnType<Project["addSourceFileAtPath"]>,
  sourceText: string,
  specs: Map<string, ToolSpec>,
  returnSchemas: Record<string, string>
): void {
  const createApi = sourceFile.getFunction("createAgentApi");
  if (!createApi) return;

  const body = createApi.getBody();
  if (!body) return;

  const returnStmt = body.getStatements().find((s) => s.getKind() === SyntaxKind.ReturnStatement);
  if (!returnStmt) return;

  const ret = returnStmt.asKindOrThrow(SyntaxKind.ReturnStatement).getExpression();
  if (!ret || ret.getKind() !== SyntaxKind.ObjectLiteralExpression) return;

  const obj = ret.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
  for (const prop of obj.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const pa = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
    const parentName = pa.getNameNode().getText();
    if (parentName !== "vm_serial") continue;

    const init = pa.getInitializer();
    if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
    const childObj = init.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);

    for (const childProp of childObj.getProperties()) {
      if (childProp.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const cpa = childProp.asKindOrThrow(SyntaxKind.PropertyAssignment);
      const name = `${parentName}.${cpa.getNameNode().getText()}`;
      if (specs.has(name)) continue;

      const childInit = cpa.getInitializer();
      if (!childInit) continue;
      const kind = childInit.getKind();
      if (kind !== SyntaxKind.ArrowFunction && kind !== SyntaxKind.FunctionExpression) continue;

      const fn = childInit.asKindOrThrow(SyntaxKind.ArrowFunction);
      const params = fn.getParameters();
      const firstParam = params[0];
      const paramsStr = firstParam?.getTypeNode()?.getText();

      const jsdocRaw = getJsDocBeforeNode(sourceText, cpa.getStart());
      const parsed = jsdocRaw ? parseJsDoc(jsdocRaw) : { description: `Tool ${name}`, params: undefined };

      const paramsSchema = paramsStr ? tsTypeToJsonSchema(paramsStr) : undefined;
      specs.set(name, {
        name,
        description: parsed.description,
        params: parsed.params ?? paramsStr,
        paramsType: paramsStr,
        paramsSchema,
        returns: returnSchemas[name] ?? DEFAULT_RETURNS,
      });
    }
    break;
  }
}

function generateOutput(specs: ToolSpec[]): string {
  const specLines = specs.map((s) => {
    const parts = [
      `name: ${JSON.stringify(s.name)}`,
      `description: ${JSON.stringify(s.description)}`,
      `returns: ${JSON.stringify(s.returns)}`,
    ];
    if (s.params) parts.push(`params: ${JSON.stringify(s.params)}`);
    if (s.paramsType) parts.push(`paramsType: ${JSON.stringify(s.paramsType)}`);
    if (s.paramsSchema) parts.push(`paramsSchema: ${JSON.stringify(s.paramsSchema)}`);
    return `  { ${parts.join(", ")} }`;
  });

  const lines = [
    "/* eslint-disable */",
    "/**",
    " * Auto-generated from agent-api.ts. Fully declarative spec.",
    " * Run: npx tsx scripts/generate-agent-api-spec.ts",
    " */",
    "",
    "export interface ToolSpec {",
    "  name: string;",
    "  description: string;",
    "  returns: string;",
    "  params?: string;",
    "  paramsType?: string;",
    "  paramsSchema?: Record<string, unknown>;",
    "}",
    "",
    "export const TOOL_SPECS: ToolSpec[] = [",
    ...specLines.map((s, i) => (i < specLines.length - 1 ? s + "," : s)),
    "];",
    "",
  ];
  return lines.join("\n");
}

function main(): void {
  const specs = extractToolSpecs();
  const output = generateOutput(specs);
  writeFileSync(OUTPUT_PATH, output, "utf-8");
  console.log(`Generated ${OUTPUT_PATH} with ${specs.length} tools`);
}

main();
