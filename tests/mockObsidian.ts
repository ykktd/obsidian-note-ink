const create=(parent:HTMLElement,tag:string,options:any={})=>{
  if(typeof options==='string')options={cls:options};
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
  app:any;leaf:any;containerEl:HTMLElement;contentEl:HTMLElement;file:any;actions:HTMLElement;
  constructor(leaf:any){this.leaf=leaf;this.app=leaf.app;this.containerEl=create(document.body,'main',{cls:'workspace-leaf-content'});this.actions=create(this.containerEl,'header',{cls:'view-header'});create(this.actions,'button',{cls:'view-action mod-more-options',text:'…',attr:{'aria-label':'タブのその他の操作'}});this.contentEl=create(this.containerEl,'div',{cls:'view-content'});}
  async setState(state:any){this.file=this.app.vault.getAbstractFileByPath(state.file);}getState(){return{};}onPaneMenu(){}
  addAction(icon:string,title:string,callback:any){const button=create(this.actions,'button',{text:title,attr:{'aria-label':title}});button.addEventListener('click',callback);return button;}
}
export class Notice {el:HTMLElement;constructor(message:string,timeout=4000){this.el=create(document.body,'div',{cls:'notice',text:message});if(timeout)setTimeout(()=>this.hide(),timeout);}setMessage(message:string){this.el.textContent=message;}hide(){this.el.remove();}}
export class Menu {
 items:any[]=[];addItem(fn:any){const item:any={title:'',disabled:false,callback:null,setTitle(v:string){this.title=v;return this;},setIcon(){return this;},setDisabled(v:boolean){this.disabled=v;return this;},setChecked(){return this;},onClick(fn:any){this.callback=fn;return this;}};fn(item);this.items.push(item);return this;}
 addSeparator(){}showAtMouseEvent(){const menu=create(document.body,'div',{cls:'test-menu'});for(const item of this.items){const b=create(menu,'button',{text:item.title});(b as HTMLButtonElement).disabled=item.disabled;b.onclick=()=>{menu.remove();item.callback?.();};}}
}
export class Modal {contentEl=create(document.body,'div',{cls:'modal-content'});constructor(public app:any){}open(){(this as any).onOpen?.();}close(){this.contentEl.remove();}}
export class Setting {}
export class Plugin {manifest={id:"obsidian-lecture-ink"};constructor(public app:any){}}
export class PluginSettingTab {constructor(public app:any,public plugin:any){}}
export function normalizePath(path:string){return path.replace(/\\/g,'/');}
export function setIcon(el:HTMLElement,icon:string){
 el.dataset.icon=icon;
 const paths:Record<string,string>={
  'grip-vertical':'M9 4v1 M9 11v1 M9 18v1 M15 4v1 M15 11v1 M15 18v1',
  'minus':'M5 12h14',
  'panel-top-open':'M3 3h18v18H3z M3 8h18 M9 15l3-3 3 3',
  'save':'M5 3h12l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8',
  'pencil':'M4 20l4-1L20 7l-3-3L5 16z M14 7l3 3',
  'highlighter':'M5 16l5 3 10-10-5-5z M5 16l-1 4 4-1',
  'eraser':'M3 14l9-10 8 8-8 8H8z M7 10l8 8 M12 20h9',
  'text-select':'M5 4h14 M12 4v16 M8 20h8',
  'sliders-horizontal':'M3 6h18 M3 12h18 M3 18h18 M7 3v6 M16 9v6 M10 15v6',
  'undo-2':'M9 4L4 9l5 5 M4 9h10a6 6 0 0 1 0 12',
  'redo-2':'M15 4l5 5-5 5 M20 9H10a6 6 0 0 0 0 12',
  'chevron-down':'M6 9l6 6 6-6'
 };
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','20');svg.setAttribute('height','20');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','2');svg.setAttribute('aria-hidden','true');
 const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[icon]??'M4 12h16');svg.append(path);el.replaceChildren(svg);
}
export const MarkdownRenderer={render:async()=>{}};
export async function loadPdfJs(){const pdf=await import(/* @vite-ignore */ '/pdfjs/pdf.mjs' as string);pdf.GlobalWorkerOptions.workerSrc='/pdfjs/pdf.worker.mjs';return pdf;}

export const Platform = {isMobileApp:false};
