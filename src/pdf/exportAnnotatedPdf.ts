import {
  PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString,
  concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState,
} from 'pdf-lib';
import type { InkStroke, PdfTextAnnotation } from '../ink/types';
import { drawStrokes } from '../ink/renderer';

export type Matrix = [number, number, number, number, number, number];
export type ExportPage = {
  pageNumber: number;
  width: number;
  height: number;
  offsetY: number;
  /** PDF user space -> the displayed page shell, including letterbox offsets. */
  transform: Matrix;
};
export type ExportProgress = (completed: number, total: number) => void;
const MAX_OVERLAY_PIXELS = 4_000_000;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

export function invertMatrix(m: Matrix): Matrix {
  const [a,b,c,d,e,f] = m;
  const determinant = a*d-b*c;
  if (!m.every(Number.isFinite) || Math.abs(determinant) < 1e-10) {
    throw new Error('PDFのページ座標を読み取れません。');
  }
  return [d/determinant,-b/determinant,-c/determinant,a/determinant,
    (c*f-d*e)/determinant,(b*e-a*f)/determinant];
}
export function transformPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
}
/** PDF image unit square is bottom-up; our overlay is top-down. */
export function overlayMatrix(page: ExportPage): Matrix {
  const [a,b,c,d,e,f] = invertMatrix(page.transform);
  return [a*page.width,b*page.width,-c*page.height,-d*page.height,
    c*page.height+e,d*page.height+f];
}

function safeColor(value: string): string {
  return /^#[\da-f]{6}$/i.test(value) ? value : '#111111';
}

export function drawPageOverlay(
  ctx: CanvasRenderingContext2D, page: ExportPage,
  strokes: readonly InkStroke[], annotations: readonly PdfTextAnnotation[],
): void {
  // Match the viewer: text marks are behind the handwriting canvas.
  for (const annotation of annotations) {
    if (annotation.pageNumber !== page.pageNumber) continue;
    const sx = page.width / (annotation.pageWidth || page.width);
    const sy = page.height / (annotation.pageHeight || page.height);
    ctx.save();
    ctx.fillStyle = safeColor(annotation.color);
    ctx.globalAlpha = annotation.kind === 'underline' || annotation.kind === 'strikethrough' ? 0.86 : 0.42;
    for (const rect of annotation.rects) {
      const x = rect.x*sx, y = rect.y*sy, w = rect.width*sx, h = rect.height*sy;
      if (annotation.kind === 'underline') ctx.fillRect(x,y+Math.max(1,h-2),w,2);
      else if (annotation.kind === 'strikethrough') ctx.fillRect(x,y+Math.max(1,Math.round(h/2)-1),w,2);
      else ctx.fillRect(x,y,w,h);
    }
    if (annotation.kind === 'note' && annotation.note && annotation.rects[0]) {
      const rect = annotation.rects[0];
      ctx.globalAlpha = 1;
      ctx.fillRect(Math.max(0,(rect.x+rect.width)*sx-8),Math.max(0,rect.y*sy-8),12,12);
    }
    ctx.restore();
  }
  const local = strokes.filter(stroke => stroke.points.some(point =>
    point.y >= page.offsetY - stroke.width && point.y <= page.offsetY+page.height+stroke.width))
    .map(stroke => ({...stroke,color:safeColor(stroke.color),
      width:Math.max(0.1,Math.min(144,stroke.width)),
      points:stroke.points.map(point => ({...point,y:point.y-page.offsetY}))}));
  drawStrokes(ctx,local);
}

async function pngBytes(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const blob = await new Promise<Blob>((resolve,reject) => canvas.toBlob(value =>
    value ? resolve(value) : reject(new Error('手書きの画像を作成できませんでした。')), 'image/png'));
  return blob.arrayBuffer();
}

/** Pure browser implementation: no network, Node, Electron or modification of the source. */
export async function exportAnnotatedPdf(
  source: Uint8Array, pages: readonly ExportPage[], strokes: readonly InkStroke[],
  annotations: readonly PdfTextAnnotation[], onProgress: ExportProgress = () => {},
): Promise<Uint8Array> {
  if (source.byteLength > MAX_SOURCE_BYTES) throw new Error('100MBを超えるPDFは、この版では書き出せません。');
  const doc = await PDFDocument.load(source.slice(), {updateMetadata:false});
  if (doc.getPageCount() !== pages.length) throw new Error('PDFが変更されました。開き直してから保存してください。');
  // Preserve forms and existing content; never flatten or alter the original source file.
  for (let index=0; index<pages.length; index++) {
    const layout=pages[index];
    if (layout.pageNumber !== index+1 || !(layout.width>0) || !(layout.height>0)) {
      throw new Error('PDFのページ情報が一致しません。');
    }
    const page=doc.getPage(index);
    const hasInk=strokes.some(s=>s.points.some(p=>p.y>=layout.offsetY-s.width && p.y<=layout.offsetY+layout.height+s.width));
    const marks=annotations.filter(a=>a.pageNumber===layout.pageNumber);
    if (hasInk || marks.length) {
      const canvas=document.createElement('canvas');
      // One bounded canvas at a time, irrespective of the number of slides.
      const scale=Math.min(2,Math.sqrt(MAX_OVERLAY_PIXELS/(layout.width*layout.height)));
      canvas.width=Math.max(1,Math.floor(layout.width*scale));
      canvas.height=Math.max(1,Math.floor(layout.height*scale));
      try {
        const ctx=canvas.getContext('2d');
        if (!ctx) throw new Error('PDF保存用の描画領域を作成できませんでした。');
        ctx.setTransform(canvas.width/layout.width,0,0,canvas.height/layout.height,0,0);
        drawPageOverlay(ctx,layout,strokes,marks);
        const image=await doc.embedPng(await pngBytes(canvas));
        const key=page.node.newXObject('LectureInk',image.ref);
        page.pushOperators(pushGraphicsState(),concatTransformationMatrix(...overlayMatrix(layout)),drawObject(key),popGraphicsState());
        // Comment text stays readable in other PDF viewers, including Japanese UTF-16.
        for (const note of marks.filter(a=>a.kind==='note' && a.note && a.rects[0])) {
          const rect=note.rects[0], inverse=invertMatrix(layout.transform);
          const [x,y]=transformPoint(inverse,rect.x*layout.width/(note.pageWidth||layout.width),rect.y*layout.height/(note.pageHeight||layout.height));
          const ref=doc.context.register(doc.context.obj({
            Type:PDFName.of('Annot'),Subtype:PDFName.of('Text'),
            Rect:[x,y,x+16,y+16],Contents:PDFHexString.fromText(note.note!),
            T:PDFHexString.fromText('Note Ink'),Name:PDFName.of('Comment'),
            F:PDFNumber.of(4),P:page.ref,NM:PDFString.of(`lecture-ink-${note.id}`),
          }));
          page.node.addAnnot(ref);
        }
      } finally { canvas.width=canvas.height=0; }
    }
    onProgress(index+1,pages.length);
    await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
  // AcroForm and all existing pages are retained. Existing digital signatures on a COPY
  // are invalidated by reserializing; this is documented in README.
  return doc.save({updateFieldAppearances:false});
}
