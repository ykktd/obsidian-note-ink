/** Exercise the paired Pointer/Touch streams emitted for one iPad Pencil contact. */
export async function highlighterInputChecks(h:any) {
  const controller=h.session.controller, original=controller.getStrokes(), state=controller.getToolState();
  const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  const results:Array<{order:string;during:number;strokes:number;points:number;maxAlpha:number;undone:number;redone:number}>=[];
  try {
    for(const order of ['pointer-first','touch-first','pointer-only','touch-only','tap']) {
      controller.replaceStrokes([]);
      controller.setToolState({tool:'highlighter',highlighterColor:'#ffd54a',highlighterWidth:18});
      const p=h.point(1,160,180),target=document.elementFromPoint(p.x,p.y)!;
      const pointer=(type:string,dx=0)=>target.dispatchEvent(new PointerEvent(type,{view:window,bubbles:true,cancelable:true,pointerType:'pen',pointerId:77,button:0,buttons:type==='pointerup'?0:1,pressure:type==='pointerup'?0:.7,clientX:p.x+dx,clientY:p.y}));
      const touch=(type:string,dx=0)=>{
        const contact={identifier:88,target,clientX:p.x+dx,clientY:p.y,force:.7,touchType:'stylus'};
        const list=(items:any[])=>Object.assign(items,{item:(i:number)=>items[i]??null});
        const event=new Event(type,{bubbles:true,cancelable:true});
        Object.defineProperties(event,{touches:{value:list(type==='touchend'?[]:[contact])},changedTouches:{value:list([contact])}});
        target.dispatchEvent(event);
      };
      if(order==='touch-first'||order==='touch-only')touch('touchstart');
      if(order!=='touch-only')pointer('pointerdown');
      await frame();
      if(order==='pointer-first'||order==='tap')touch('touchstart');
      const during=controller.getStrokes().length;
      if(order!=='tap') {
        // Alternate both streams after their initial starts, including a pause longer
        // than the old touch-pointer suppression window.
        if(order==='pointer-first')await new Promise(r=>setTimeout(r,750));
        for(const dx of [20,40,60,80]) {
          if(order!=='touch-only')pointer('pointermove',dx);
          if(order!=='pointer-only')touch('touchmove',dx);
          await frame();
        }
      }
      const end=order==='tap'?0:80;
      if(order!=='pointer-only')touch('touchend',end);
      if(order!=='touch-only')pointer('pointerup',end);
      await frame();
      const saved=controller.getStrokes(),input=controller.input;
      const pixels=input.committed.getContext('2d').getImageData(0,0,input.committed.width,input.committed.height).data;
      let maxAlpha=0;for(let i=3;i<pixels.length;i+=4)maxAlpha=Math.max(maxAlpha,pixels[i]);
      controller.undo();const undone=controller.getStrokes().length;controller.redo();
      results.push({order,during,strokes:saved.length,points:saved[0]?.points.length,maxAlpha,undone,redone:controller.getStrokes().length});
    }
    // Separate contacts must still darken deliberately overlaid marker strokes.
    controller.replaceStrokes([]);h.pen(1,160,180);h.pen(1,160,180);
    const separate=controller.getStrokes().length;
    return {results,separate};
  } finally {controller.replaceStrokes(original);controller.setToolState(state);}
}
