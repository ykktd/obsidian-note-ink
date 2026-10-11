// Bound document-controlled geometry BEFORE any DOM/canvas/tiling allocation.
export const MAX_MARKDOWN_WIDTH=16_000;
export const MAX_DOCUMENT_HEIGHT=160_000;
export const MAX_PDF_PAGE_HEIGHT=16_000;
export const MAX_PDF_PAGES=1_000;
export function assertDimensions(width:number,height:number,maxHeight=MAX_DOCUMENT_HEIGHT):void {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>MAX_MARKDOWN_WIDTH||height>maxHeight) {
    throw new Error('ページが大きすぎるため開けません。PDFを分割するか、書き込みデータを確認してください。');
  }
}
