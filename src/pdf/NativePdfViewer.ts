import type { WorkspaceLeaf } from "obsidian";
import type { PdfDocument, PdfPage, PdfViewport } from "./pdfCoordinates";

export type NativePageView = {id:number;div:HTMLElement;canvas?:HTMLCanvasElement;pdfPage?:PdfPage;viewport:PdfViewport;renderingState:number};
export type NativeEventBus = {on(name:string,callback:(data?:any)=>void):void;off(name:string,callback:(data?:any)=>void):void};
export type NativeViewer = {
  container:HTMLElement;viewer:HTMLElement;pdfDocument:PdfDocument;pagesCount:number;
  currentPageNumber:number;currentScale:number;pagesRotation:number;
  getPageView(index:number):NativePageView;getCachedPageViews():Set<NativePageView>;
};
export type NativePdfBinding = {view:any;viewer:NativeViewer;eventBus:NativeEventBus;pdf:PdfDocument};

/** All access to Obsidian's private PDF integration is confined to this adapter. */
export async function connectNativePdf(leaf:WorkspaceLeaf,sourcePath:string):Promise<NativePdfBinding> {
  const view=leaf.view as any;
  if(view?.getViewType?.()!=="pdf"||!view.viewer||typeof view.viewer.then!=="function")throw unsupported();
  const child=await deadline(new Promise<any>((resolve,reject)=>{
    try {view.viewer.then((value:any)=>{resolve(value);});}catch(error){reject(error);}
  }));
  const app=child?.pdfViewer,viewer=app?.pdfViewer,bus=app?.eventBus;
  if(!viewer||!bus||typeof viewer.getPageView!=="function"||typeof viewer.getCachedPageViews!=="function"||typeof bus.on!=="function"||typeof bus.off!=="function"||!viewer.container||!viewer.viewer)throw unsupported();
  if(!viewer.pdfDocument){
    if(app.pdfLoadingTask?.promise)await deadline(app.pdfLoadingTask.promise);
    let ready=()=>{};
    if(!viewer.pdfDocument)await deadline(new Promise<void>(resolve=>{
      ready=()=>{bus.off("pagesinit",ready);resolve();};bus.on("pagesinit",ready);
      // A loading task can finish between the shape check and listener registration.
      if(viewer.pdfDocument)ready();
    }),()=>bus.off("pagesinit",ready));
  }
  if(leaf.view!==view||view.file?.path!==sourcePath)throw new Error("表示するPDFが変わりました。もう一度、注釈を開いてください。");
  const pdf=viewer.pdfDocument;
  if(!pdf||typeof pdf.getPage!=="function"||typeof pdf.getData!=="function")throw unsupported();
  return {view,viewer,eventBus:bus,pdf};
}
function unsupported():Error{return new Error("このObsidianでは注釈層を接続できません。通常のPDF表示はそのまま使えます。");}
async function deadline<T>(promise:Promise<T>,cleanup=()=>{}):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error("PDFの準備を待っています。表示が終わってから、もう一度注釈を開いてください。")),15000);})]);}
  finally {clearTimeout(timer);cleanup();}
}
