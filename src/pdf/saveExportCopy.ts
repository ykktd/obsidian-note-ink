/** Only create new files; a sync race or failed create must never fall back to overwrite. */
export async function saveExportCopy(
  vault: {
    getAbstractFileByPath(path: string): unknown;
    adapter: {exists(path: string): Promise<boolean>};
    createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
  }, sourcePath: string, bytes: Uint8Array,
): Promise<string> {
  if (!sourcePath || sourcePath.startsWith('/') || sourcePath.split('/').some(p=>!p || p==='.' || p==='..') || !/\.pdf$/i.test(sourcePath)) {
    throw new Error('PDFの保存先が不正です。');
  }
  const stem=sourcePath.replace(/\.pdf$/i,'');
  for (let number=1; number<=1000; number++) {
    const path=`${stem}-書き込み${number===1?'':`-${number}`}.pdf`;
    if (vault.getAbstractFileByPath(path) || await vault.adapter.exists(path)) continue;
    try {
      const copy=bytes.slice();
      await vault.createBinary(path,copy.buffer as ArrayBuffer);
      return path;
    } catch (error) {
      // If another process created it meanwhile, try another name; never modify it.
      if (vault.getAbstractFileByPath(path) || await vault.adapter.exists(path)) continue;
      throw error;
    }
  }
  throw new Error('保存先の同名PDFが多すぎます。フォルダを整理してください。');
}
