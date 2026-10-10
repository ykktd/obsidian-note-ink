import type { AnnotationFile, InkStroke, PdfAnnotationFile, PdfInkStroke, PdfTextAnnotationRect } from "../ink/types";
import { invertMatrix, transformPoint, type Matrix } from "./exportAnnotatedPdf";

export type PdfViewport = { width: number; height: number; scale: number; rotation: number; transform: Matrix };
export type PdfPage = { getViewport(options: { scale: number; rotation?: number }): PdfViewport };
export type PdfDocument = { numPages: number; getPage(number: number): Promise<PdfPage>; getData(): Promise<Uint8Array> };

export function transformRect(rect: PdfTextAnnotationRect, matrix: Matrix): PdfTextAnnotationRect {
  const points = [[rect.x,rect.y],[rect.x+rect.width,rect.y],[rect.x,rect.y+rect.height],[rect.x+rect.width,rect.y+rect.height]]
    .map(([x,y])=>transformPoint(matrix,x,y));
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const x=Math.min(...xs),y=Math.min(...ys);
  return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};
}

export function pdfMarkShapes(mark: PdfAnnotationFile["pdfTextAnnotations"][number],page:PdfPage,target:PdfViewport):PdfTextAnnotationRect[]{
  if(mark.kind!=="underline"&&mark.kind!=="strikethrough")return mark.rects.map(r=>transformRect(r,target.transform));
  const creation=page.getViewport({scale:1,rotation:mark.rotation??page.getViewport({scale:1}).rotation}),inverse=invertMatrix(creation.transform);
  return mark.rects.map(rect=>{
    const r=transformRect(rect,creation.transform),line={x:r.x,y:mark.kind==="underline"?r.y+r.height-1.5:r.y+r.height/2,width:r.width,height:1.5};
    return transformRect(transformRect(line,inverse),target.transform);
  });
}

export function toViewportStroke(stroke: InkStroke, viewport: PdfViewport): InkStroke {
  return {...stroke,width:stroke.width*viewport.scale,points:stroke.points.map(p=>{
    const [x,y]=transformPoint(viewport.transform,p.x,p.y);return {...p,x,y};
  })};
}
export function toPdfStroke(stroke: InkStroke, pageNumber: number, viewport: PdfViewport, width=viewport.width,height=viewport.height): PdfInkStroke {
  const inverse=invertMatrix(viewport.transform);
  return {...stroke,pageNumber,width:stroke.width/viewport.scale,points:stroke.points.map(p=>{
    const [x,y]=transformPoint(inverse,p.x*viewport.width/width,p.y*viewport.height/height);return {...p,x,y};
  })};
}

/** Reproduce v1's uniform page shells, including its fixed 12px page gap and letterboxing. */
export async function migratePdfAnnotation(legacy: AnnotationFile, pdf: PdfDocument): Promise<PdfAnnotationFile> {
  if(!Number.isFinite(legacy.pageWidth)||legacy.pageWidth<=0||!Number.isFinite(legacy.pageHeight)||legacy.pageHeight<=0)throw new Error("旧注釈のページ寸法を読み取れません。元の注釈は保持しています。");
  const gap=12, shellWidth=legacy.pageWidth;
  // Stored height includes every uniform page shell and the gaps, even for mixed-size PDFs.
  const first=(await pdf.getPage(1)).getViewport({scale:1});
  const shellHeight=pdf.numPages===1&&legacy.pageHeight===480
    ? Math.min(480,Math.ceil(first.height*shellWidth/first.width))
    : (legacy.pageHeight-gap*(pdf.numPages-1))/pdf.numPages;
  if(!(shellHeight>0))throw new Error("旧注釈のページ数とPDFが一致しません。");
  const layouts=new Map<number,{viewport:PdfViewport;offsetY:number}>();
  const getLayout=async(n:number)=>{
    let layout=layouts.get(n);if(layout)return layout;
    const page=await pdf.getPage(n),base=page.getViewport({scale:1});
    const scale=Math.min(shellWidth/base.width,shellHeight/base.height),viewport=page.getViewport({scale});
    viewport.transform=[...viewport.transform] as Matrix;
    viewport.transform[4]+=(shellWidth-viewport.width)/2;viewport.transform[5]+=(shellHeight-viewport.height)/2;
    layout={viewport,offsetY:(n-1)*(shellHeight+gap)};layouts.set(n,layout);return layout;
  };
  const strokes:PdfInkStroke[]=[];
  for(const stroke of legacy.strokes){
    const bounds=stroke.points.reduce((b,p)=>({min:Math.min(b.min,p.y),max:Math.max(b.max,p.y)}),{min:Infinity,max:-Infinity});
    const min=bounds.min-stroke.width,max=bounds.max+stroke.width;
    const start=Math.max(1,Math.floor(min/(shellHeight+gap))+1),end=Math.min(pdf.numPages,Math.floor(max/(shellHeight+gap))+1);
    if(start>end)throw new Error("PDFの外側にある旧筆跡を変換できません。元の注釈は保持しています。");
    // A boundary-crossing stroke is represented on each page and clipped by that page.
    for(let n=start;n<=end;n++){
      const {viewport,offsetY}=await getLayout(n),inverse=invertMatrix(viewport.transform);
      strokes.push({...stroke,id:start===end?stroke.id:`${stroke.id}:page:${n}`,pageNumber:n,width:stroke.width/viewport.scale,
        points:stroke.points.map(p=>{const [x,y]=transformPoint(inverse,p.x,p.y-offsetY);return {...p,x,y};})});
    }
  }
  const annotations:PdfAnnotationFile["pdfTextAnnotations"]=[];
  for(const mark of legacy.pdfTextAnnotations??[]){
    if(mark.pageNumber<1||mark.pageNumber>pdf.numPages)throw new Error("旧注釈のページ番号とPDFが一致しません。");
    const {viewport}=await getLayout(mark.pageNumber),inverse=invertMatrix(viewport.transform);
    const sx=shellWidth/(mark.pageWidth||shellWidth),sy=shellHeight/(mark.pageHeight||shellHeight);
    annotations.push({...mark,rotation:viewport.rotation,pageWidth:undefined,pageHeight:undefined,rects:mark.rects.map(r=>transformRect({x:r.x*sx,y:r.y*sy,width:r.width*sx,height:r.height*sy},inverse))});
  }
  return {version:2,kind:"pdf",coordinateSpace:"pdf-user-space",sourcePath:legacy.sourcePath,sourceMtime:legacy.sourceMtime,pageCount:pdf.numPages,strokes,pdfTextAnnotations:annotations,updatedAt:legacy.updatedAt};
}

/** Fail closed instead of silently discarding damaged or future-format annotations. */
export function validatePdfAnnotation(value: unknown, sourcePath: string, pageCount: number): PdfAnnotationFile {
  const data=value as PdfAnnotationFile;
  if(!data||data.version!==2||data.kind!=="pdf"||data.coordinateSpace!=="pdf-user-space"||data.sourcePath!==sourcePath||data.pageCount!==pageCount||!Array.isArray(data.strokes)||!Array.isArray(data.pdfTextAnnotations))throw new Error("注釈の形式またはPDFのページ数が一致しません。元の注釈は保持しています。");
  const ids=new Set<string>();
  for(const stroke of data.strokes){
    if(!stroke||typeof stroke.id!=="string"||ids.has(stroke.id)||!validPage(stroke.pageNumber,pageCount)||!["pen","highlighter"].includes(stroke.tool)||!/^#[\da-f]{6}$/i.test(stroke.color)||!Number.isFinite(stroke.width)||stroke.width<=0||!Array.isArray(stroke.points)||!stroke.points.length||stroke.points.some(p=>!p||![p.x,p.y,p.t,p.pressure].every(Number.isFinite)))throw new Error("保存済みの筆跡を読み取れません。元の注釈は保持しています。");
    ids.add(stroke.id);
  }
  for(const mark of data.pdfTextAnnotations){
    if(!mark||typeof mark.id!=="string"||!validPage(mark.pageNumber,pageCount)||!["highlight","underline","strikethrough","note"].includes(mark.kind)||!/^#[\da-f]{6}$/i.test(mark.color)||typeof mark.text!=="string"||!Array.isArray(mark.rects)||!mark.rects.length||mark.rects.some(r=>!r||![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.width<=0||r.height<=0))throw new Error("保存済みの文字注釈を読み取れません。元の注釈は保持しています。");
  }
  return structuredClone(data);
}
const validPage=(n:number,count:number)=>Number.isInteger(n)&&n>=1&&n<=count;
