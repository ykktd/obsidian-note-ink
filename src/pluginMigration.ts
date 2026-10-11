import type { App, Plugin } from "obsidian";
import { VIEW_TYPE_MOBILE_INK } from "./constants";

export const PLUGIN_ID = "obsidian-note-ink";
export const LEGACY_PLUGIN_ID = "obsidian-lecture-ink";

/** Copy before retiring the old installation; never overwrite either copy of user data. */
export async function migrateLegacyPluginData(app: App, plugin: Plugin): Promise<void> {
  if (plugin.manifest.id !== PLUGIN_ID) return;
  const adapter = app.vault.adapter;
  const config = app.vault.configDir ?? ".obsidian";
  const source = `${config}/plugins/${LEGACY_PLUGIN_ID}`;
  if (!(await adapter.exists(source))) return;
  const target = plugin.manifest.dir ?? `${config}/plugins/${PLUGIN_ID}`;
  if (target === source) throw new Error("Note Ink のフォルダ名を obsidian-note-ink に変更してから有効にしてください。");

  // BRAT installs a changed manifest ID as a new plugin. Flush the live old instance
  // before disabling it so its final save cannot race with the data copy.
  const manager = (app as any).plugins;
  const previous = manager?.plugins?.[LEGACY_PLUGIN_ID];
  if (previous) {
    for (const session of previous.pdfSessions?.values() ?? []) await session.close();
    for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_MOBILE_INK)) {
      if ((leaf.view as any).plugin === previous) await (leaf.view as any).flushCurrentWork();
    }
  }
  if (previous || manager?.enabledPlugins?.has(LEGACY_PLUGIN_ID)) {
    if (!manager?.disablePluginAndSave) throw new Error("以前の Note Ink を無効にしてから、もう一度有効にしてください。");
    await manager.disablePluginAndSave(LEGACY_PLUGIN_ID);
  }

  const ensure = async (path: string) => { if (!(await adapter.exists(path))) await adapter.mkdir(path); };
  await ensure(target);
  const backups = `${config}/note-ink-backups`;
  await ensure(backups);
  const marker = `${target}/legacy-data-migrated.json`;
  let completed = false;
  if (await adapter.exists(marker)) {
    try { completed = JSON.parse(await adapter.read(marker)).from === LEGACY_PLUGIN_ID; } catch { /* Retry an interrupted marker write. */ }
  }
  if (!completed) {
    const copy = async (from: string, to: string): Promise<void> => {
      if (await adapter.exists(to)) return;
      const raw = await adapter.read(from);
      const temporary = `${to}.note-ink-migration.tmp`;
      await adapter.write(temporary, raw);
      if (await adapter.read(temporary) !== raw) throw new Error("設定・書き込みを引き継げませんでした。以前のデータは残っています。");
      if (!(await adapter.exists(to))) await adapter.rename(temporary, to);
    };
    const data = `${source}/data.json`;
    if (await adapter.exists(data)) {
      JSON.parse(await adapter.read(data));
      await copy(data, `${target}/data.json`);
    }
    const copyFolder = async (from: string, to: string): Promise<void> => {
      await ensure(to);
      const entries = await adapter.list(from);
      for (const file of entries.files) await copy(file, `${to}/${file.slice(from.length + 1)}`);
      for (const folder of entries.folders) await copyFolder(folder, `${to}/${folder.slice(from.length + 1)}`);
    };
    if (await adapter.exists(`${source}/annotations`)) await copyFolder(`${source}/annotations`, `${target}/annotations`);
    const renameId = (value: string) => value === LEGACY_PLUGIN_ID || value.startsWith(`${LEGACY_PLUGIN_ID}:`)
      ? PLUGIN_ID + value.slice(LEGACY_PLUGIN_ID.length) : value;
    const updateIds = (value: any): any => {
      if (typeof value === "string") return renameId(value);
      if (Array.isArray(value)) return value.map(updateIds);
      if (value && typeof value === "object") {
        const result: Record<string, any> = {};
        // Existing preferences for the new ID win over their legacy counterparts.
        for (const [key, item] of Object.entries(value)) if (renameId(key) === key) result[key] = updateIds(item);
        for (const [key, item] of Object.entries(value)) if (!(renameId(key) in result)) result[renameId(key)] = updateIds(item);
        return result;
      }
      return value;
    };
    for (const name of ["hotkeys.json", "workspace.json", "workspace-mobile.json"]) {
      const path = `${config}/${name}`;
      if (!(await adapter.exists(path))) continue;
      const raw = await adapter.read(path);
      if (!raw.includes(LEGACY_PLUGIN_ID)) continue;
      const updated = updateIds(JSON.parse(raw));
      await copy(path, `${backups}/${name}.before-note-ink-migration.bak`);
      await adapter.write(path, JSON.stringify(updated, null, 2));
      if (name === "hotkeys.json" && (app as any).hotkeyManager?.customKeys) (app as any).hotkeyManager.customKeys = updated;
    }
    await adapter.write(marker, JSON.stringify({ from: LEGACY_PLUGIN_ID, migratedAt: Date.now() }));
  }

  // Outside plugins/: Obsidian will no longer list or load the duplicate installation.
  let backup = `${backups}/${LEGACY_PLUGIN_ID}`;
  for (let n = 2; await adapter.exists(backup); n++) backup = `${backups}/${LEGACY_PLUGIN_ID}-${n}`;
  await adapter.rename(source, backup);
  await manager?.loadManifests?.();
}
