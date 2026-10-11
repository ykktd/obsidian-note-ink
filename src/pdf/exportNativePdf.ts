import type { PdfAnnotationFile } from "../ink/types";
import { exportAnnotatedPdf, type ExportPage, type ExportProgress, type PageOverlayContent } from "./exportAnnotatedPdf";
import { toViewportStroke, transformRect, pdfMarkShapes, type PdfDocument } from "./pdfCoordinates";

/** Export directly from the v2 document. Display coordinates exist only for this render. */
export async function exportNativePdf(pdf:PdfDocument,annotation:PdfAnnotationFile,onProgress:ExportProgress):Promise<Uint8Array>{
  const snapshot=structuredClone(annotation),layouts:ExportPage[]=[],content=new Map<number,PageOverlayContent>();
  for(let n=1;n<=pdf.numPages;n++){
    const page=await pdf.getPage(n),viewport=page.getViewport({scale:1});
    layouts.push({pageNumber:n,width:viewport.width,height:viewport.height,offsetY:0,transform:viewport.transform});
    const marks=snapshot.pdfTextAnnotations.filter(a=>a.kind!=="note"&&a.pageNumber===n);
    content.set(n,{strokes:snapshot.strokes.filter(s=>s.pageNumber===n).map(s=>toViewportStroke(s,viewport)),
      annotations:marks.map(a=>({...a,pageWidth:viewport.width,pageHeight:viewport.height,rects:a.rects.map(r=>transformRect(r,viewport.transform))})),
      markShapes:new Map(marks.map(a=>[a.id,pdfMarkShapes(a,page,viewport)]))});
  }
  return exportAnnotatedPdf(await pdf.getData(),layouts,[],[],onProgress,content);
}
