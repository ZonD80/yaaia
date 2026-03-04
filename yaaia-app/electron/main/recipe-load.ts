import AdmZip from "adm-zip";

export async function loadRecipeFromZip(zipPath: string): Promise<{ ok: boolean; markdown?: string; error?: string }> {
  try {
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntry("RECIPE.md");
    if (!entry || entry.isDirectory) {
      return { ok: false, error: "ZIP does not contain RECIPE.md" };
    }
    const markdown = zip.readAsText(entry, "utf-8");
    return { ok: true, markdown };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
