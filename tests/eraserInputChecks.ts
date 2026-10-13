/** Sparse Touch updates must not block Pencil erasing, or split its undo entry. */
export async function eraserInputChecks(h:any){
  const c=h.session.controller,original=c.getStrokes(),state=c.getToolState();
  const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  const results:any[]=[];
  try{
    for(const mode of ['stroke','partial'])for(const order of ['pointer-only','touch-only','pointer-first','touch-first','touch-cancel','pointer-cancel']){
      const fixture=[120,180,230].map((y,i)=>({id:`erase-${i}`,pageNumber:1,tool:'pen',color:'#333333',width:2,points:[{x:80,y,t:0,pressure:.5},{x:280,y,t:50,pressure:.5}]}));
      c.replaceStrokes(fixture);c.setToolState({tool:'eraser',eraserMode:mode,eraserRadius:8});await frame();await frame();
      const target=h.viewer.getPageView(0).div;
      const pointer=(type:string,y:number)=>{const p=h.point(1,160,y);target.dispatchEvent(new PointerEvent(type,{view:window,bubbles:true,cancelable:true,pointerType:'pen',pointerId:91,button:0,buttons:type==='pointerup'?0:1,pressure:type==='pointerup'?0:.7,clientX:p.x,clientY:p.y}));};
      const touch=(type:string,y:number)=>{
        const p=h.point(1,160,y),t={identifier:92,target,clientX:p.x,clientY:p.y,force:.7,touchType:'stylus'};
        const event=new Event(type,{bubbles:true,cancelable:true});
        for(const [key,items]of Object.entries({touches:['touchend','touchcancel'].includes(type)?[]:[t],changedTouches:[t]}))Object.defineProperty(event,key,{value:Object.assign(items,{item:(i:number)=>items[i]??null})});
        target.dispatchEvent(event);
      };
      if(order.startsWith('touch')){
        touch('touchstart',120);
        if(order==='touch-cancel')touch('touchcancel',120);
        if(order!=='touch-only')pointer('pointerdown',120);
      }else{
        pointer('pointerdown',120);
        if(order==='pointer-cancel')pointer('pointercancel',120);
        if(order!=='pointer-only')touch('touchstart',120);
      }
      const engine=c.input.engine;
      const useTouch=order==='touch-only'||order==='pointer-cancel';
      for(const y of [135,150,165,180]){if(useTouch)touch('touchmove',y);else pointer('pointermove',y);await frame();}
      // Verify visible erasure before either input stream ends.
      const canvas=c.input.committed,rect=canvas.getBoundingClientRect(),ctx=canvas.getContext('2d');
      const alpha=(y:number)=>{const p=h.point(1,160,y);return ctx.getImageData(Math.floor((p.x-rect.left)*canvas.width/rect.width),Math.floor((p.y-rect.top)*canvas.height/rect.height),1,1).data[3];};
      const visible=[alpha(120),alpha(180),alpha(230)];
      const during=engine.getStrokes();
      if(order==='pointer-first')touch('touchend',180);
      if(useTouch)touch('touchend',180);else pointer('pointerup',180);
      if(order==='touch-first')touch('touchend',180);
      await frame();
      const saved=c.getStrokes(),ended=!c.isInputActive(),timerCleared=engine.cancelGraceTimer===null;
      c.undo();const undoRestored=JSON.stringify(c.getStrokes())===JSON.stringify(fixture);
      c.redo();const redoRestored=JSON.stringify(c.getStrokes())===JSON.stringify(saved);
      results.push({mode,order,visible,remainingDuring:during.length,cutStrokesDuring:during.filter((s:any)=>s.erasures?.length).length,ended,timerCleared,undoRestored,redoRestored});
    }
    return results;
  }finally{c.replaceStrokes(original);c.setToolState(state);}
}
