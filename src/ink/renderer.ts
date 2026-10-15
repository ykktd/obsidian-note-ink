import { InkPoint, InkStroke } from "./types";

export type CanvasRegion = { x: number; y: number; width: number; height: number };

export type CanvasSetupOptions = {
  maxDpr?: number;
  maxPixels?: number;
  displayScale?: number;
  /** Explicit backing pixels per document unit, including the viewer zoom. */
  pixelRatio?: number;
  /** Rasterize only this region while retaining full-document drawing coordinates. */
  region?: CanvasRegion;
};

export function setupCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  options: CanvasSetupOptions = {}
): CanvasRenderingContext2D {
  const deviceDpr = Math.max(1, canvas.ownerDocument.defaultView?.devicePixelRatio || 1);
  const baseDpr = Number.isFinite(options.maxDpr) && options.maxDpr && options.maxDpr > 0
    ? Math.min(deviceDpr, options.maxDpr) : deviceDpr;
  const displayScale = Number.isFinite(options.displayScale) && options.displayScale && options.displayScale > 0
    ? options.displayScale : 1;
  
  const targetDpr = Number.isFinite(options.pixelRatio) && options.pixelRatio! > 0
    ? options.pixelRatio! : Math.min(baseDpr * displayScale, options.maxDpr ?? Number.POSITIVE_INFINITY);
  const pixelCap = Number.isFinite(options.maxPixels) && options.maxPixels && options.maxPixels > 0
    ? options.maxPixels : Number.POSITIVE_INFINITY;
    
  const region = options.region ?? {x:0,y:0,width,height};
  const maxByPixels = Math.sqrt(pixelCap / Math.max(1, region.width * region.height));
  const dpr = Math.min(targetDpr, maxByPixels);
  
  if (options.region) {
    canvas.style.left = `${region.x / width * 100}%`;
    canvas.style.top = `${region.y / height * 100}%`;
    canvas.style.width = `${region.width / width * 100}%`;
    canvas.style.height = `${region.height / height * 100}%`;
    canvas.style.right = canvas.style.bottom = 'auto';
  } else {
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  canvas.width = Math.max(1, Math.floor(region.width * dpr));
  canvas.height = Math.max(1, Math.floor(region.height * dpr));
  
  const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  if (!ctx) throw new Error("Unable to create 2D canvas context");
  
  const sx=canvas.width / region.width, sy=canvas.height / region.height;
  ctx.setTransform(sx, 0, 0, sy, -region.x*sx, -region.y*sy);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

export function clearCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  ctx.clearRect(0, 0, width, height);
}

// Use the selected width everywhere: pressure, speed and stroke position do not
// change it. The same widths drive live ink, redraw/export and eraser hit testing.
const widthCache = new WeakMap<InkStroke, { base: number; points: InkPoint[]; widths: number[] }>();
export function strokeWidths(stroke: InkStroke): readonly number[] {
  let cache = widthCache.get(stroke);
  if (!cache || cache.base !== stroke.width || cache.points !== stroke.points || cache.widths.length > stroke.points.length) {
    cache = {base:stroke.width, points:stroke.points, widths:[]}; widthCache.set(stroke,cache);
  }
  const widths=cache.widths;
  for(let i=widths.length;i<stroke.points.length;i++) {
    widths.push(stroke.width);
  }
  return widths;
}

function midpoint(a: InkPoint,b: InkPoint): {x:number;y:number} { return {x:(a.x+b.x)/2,y:(a.y+b.y)/2}; }
function style(ctx:CanvasRenderingContext2D,stroke:InkStroke,opaque=false): void {
  ctx.strokeStyle=stroke.color; ctx.fillStyle=stroke.color; ctx.lineCap='round'; ctx.lineJoin='round';
  ctx.globalAlpha=stroke.tool==='highlighter' && !opaque ? .35 : 1;
  ctx.globalCompositeOperation=stroke.tool==='highlighter' && !opaque ? 'multiply' : 'source-over';
}
function curve(ctx:CanvasRenderingContext2D,points:InkPoint[],i:number): void {
  const from=i===0 ? points[0] : midpoint(points[i-1],points[i]);
  const to=midpoint(points[i],points[i+1]);
  ctx.moveTo(from.x,from.y);ctx.quadraticCurveTo(points[i].x,points[i].y,to.x,to.y);
}

/** Draw only stable midpoint segments; the final half segment is kept off the committed layer. */
export function drawStrokeSegment(ctx:CanvasRenderingContext2D,stroke:InkStroke,previousPointCount:number,opaque=false):void {
  if(stroke.points.length<2 || stroke.points.length<=previousPointCount)return;
  ctx.save();style(ctx,stroke,opaque);
  const widths=stroke.tool==='pen' ? strokeWidths(stroke) : [];
  for(let i=Math.max(0,previousPointCount-1);i<stroke.points.length-1;i++) {
    ctx.beginPath();curve(ctx,stroke.points,i);
    ctx.lineWidth=stroke.tool==='highlighter' ? stroke.width : widths[i];ctx.stroke();
  }
  ctx.restore();
}

export function drawStrokeTail(ctx:CanvasRenderingContext2D,stroke:InkStroke,opaque=false):void {
  const p=stroke.points,n=p.length;if(!n)return;
  ctx.save();style(ctx,stroke,opaque);
  const width=stroke.tool==='highlighter' ? stroke.width : strokeWidths(stroke)[n-1];
  ctx.beginPath();
  if(n===1) {ctx.arc(p[0].x,p[0].y,width/2,0,Math.PI*2);ctx.fill();}
  else {const from=midpoint(p[n-2],p[n-1]);ctx.moveTo(from.x,from.y);ctx.lineTo(p[n-1].x,p[n-1].y);ctx.lineWidth=width;ctx.stroke();}
  ctx.restore();
}

export function drawStroke(ctx:CanvasRenderingContext2D,stroke:InkStroke):void {
  if(stroke.tool!=='highlighter' && !stroke.erasures?.length) {drawStrokeSegment(ctx,stroke,0);drawStrokeTail(ctx,stroke);return;}
  if(!stroke.points.length)return;
  // Use the same opaque segment mask for live ink and export. Apply translucency once,
  // including at self-intersections and segment joins.
  const m=ctx.getTransform(),pad=stroke.width+2;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const p of stroke.points)for(const dx of [-pad,pad])for(const dy of [-pad,pad]) {
    const x=m.a*(p.x+dx)+m.c*(p.y+dy)+m.e,y=m.b*(p.x+dx)+m.d*(p.y+dy)+m.f;
    minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
  }
  const left=Math.max(0,Math.floor(minX)),top=Math.max(0,Math.floor(minY));
  const right=Math.min(ctx.canvas.width,Math.ceil(maxX)),bottom=Math.min(ctx.canvas.height,Math.ceil(maxY));
  if(right<=left || bottom<=top)return;
  const mask=document.createElement('canvas');mask.width=right-left;mask.height=bottom-top;
  try {
    const mc=mask.getContext('2d');if(!mc)throw new Error('Unable to create highlighter mask');
    mc.setTransform(m.a,m.b,m.c,m.d,m.e-left,m.f-top);
    drawStrokeSegment(mc,stroke,0,true);drawStrokeTail(mc,stroke,true);
    mc.globalCompositeOperation='destination-out';mc.globalAlpha=1;mc.lineCap='round';mc.lineJoin='round';
    for(const erase of stroke.erasures??[]){
      mc.lineWidth=erase.radius*2;mc.beginPath();
      if(erase.points.length===1){const p=erase.points[0];mc.arc(p.x,p.y,erase.radius,0,Math.PI*2);mc.fill();}
      else {erase.points.forEach((p,i)=>i?mc.lineTo(p.x,p.y):mc.moveTo(p.x,p.y));mc.stroke();}
    }
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=stroke.tool==='highlighter'?.35:1;ctx.globalCompositeOperation=stroke.tool==='highlighter'?'multiply':'source-over';ctx.drawImage(mask,left,top);ctx.restore();
  } finally {mask.width=mask.height=0;}

}
export function drawStrokes(ctx:CanvasRenderingContext2D,strokes:readonly InkStroke[]):void {for(const s of strokes)drawStroke(ctx,s);}

export function distanceSquared(a: InkPoint, b: InkPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function distancePointToSegmentSquared(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  
  if (lenSq === 0) {
    return (px - ax) ** 2 + (py - ay) ** 2;
  }
  
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
  return (px - ax - t * vx) ** 2 + (py - ay - t * vy) ** 2;
}
