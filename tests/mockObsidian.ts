const create=(parent:HTMLElement,tag:string,options:any={})=>{
  const el=document.createElement(tag);
  if(options.cls)el.className=options.cls;
  if(options.text!==undefined)el.textContent=options.text;
  for(const [key,value] of Object.entries(options.attr??{}))el.setAttribute(key,String(value));
  parent.append(el);return el;
};
Object.assign(HTMLElement.prototype,{
  createEl(this:HTMLElement,tag:string,options:any){return create(this,tag,options);},
  createDiv(this:HTMLElement,options:any){return create(this,'div',options);},
  createSpan(this:HTMLElement,options:any){return create(this,'span',options);},
  empty(this:HTMLElement){this.replaceChildren();},
  addClass(this:HTMLElement,...names:string[]){this.classList.add(...names);},
  removeClass(this:HTMLElement,...names:string[]){this.classList.remove(...names);},
  setText(this:HTMLElement,value:string){this.textContent=value;},
});
export class TFile {constructor(public path:string){} stat={mtime:1};get extension(){return this.path.split('.').pop()!;}}
export class FileView {
  app:any;containerEl:HTMLElement;contentEl:HTMLElement;file:any;actions:HTMLElement;
  constructor(leaf:any){this.app=leaf.app;this.containerEl=create(document.body,'main',{cls:'workspace-leaf-content'});this.actions=create(this.containerEl,'header');this.contentEl=create(this.containerEl,'div',{cls:'view-content'});}
  async setState(state:any){this.file=this.app.vault.getAbstractFileByPath(state.file);}getState(){return{};}onPaneMenu(){}
  addAction(icon:string,title:string,callback:any){const button=create(this.actions,'button',{text:title,attr:{'aria-label':title}});button.addEventListener('click',callback);return button;}
}
export class Notice {el:HTMLElement;constructor(message:string,timeout=4000){this.el=create(document.body,'div',{cls:'notice',text:message});if(timeout)setTimeout(()=>this.hide(),timeout);}setMessage(message:string){this.el.textContent=message;}hide(){this.el.remove();}}
export class Menu {addItem(fn:any){fn({setTitle(){return this;},setIcon(){return this;},setDisabled(){return this;},onClick(){return this;}});}addSeparator(){}}
export class Modal {contentEl=create(document.body,'div');constructor(public app:any){}open(){}close(){this.contentEl.remove();}}
export class Setting {}
export function normalizePath(path:string){return path.replace(/\\/g,'/');}
export function setIcon(el:HTMLElement,icon:string){el.dataset.icon=icon;}
export const MarkdownRenderer={render:async()=>{}};
export async function loadPdfJs(){const pdf=await import(/* @vite-ignore */ '/pdfjs/pdf.mjs' as string);pdf.GlobalWorkerOptions.workerSrc='/pdfjs/pdf.worker.mjs';return pdf;}
