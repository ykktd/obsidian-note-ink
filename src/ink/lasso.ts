import type { InkStroke } from './types';
export type Point = { x: number; y: number };
export type Bounds = { x: number; y: number; width: number; height: number };
export function strokeBounds(strokes: readonly InkStroke[]): Bounds | null {
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const s of strokes)for(const p of s.points){left=Math.min(left,p.x-s.width/2);top=Math.min(top,p.y-s.width/2);right=Math.max(right,p.x+s.width/2);bottom=Math.max(bottom,p.y+s.width/2);}
  return Number.isFinite(left)?{x:left,y:top,width:right-left,height:bottom-top}:null;
}
function cross(a:Point,b:Point,c:Point):number{return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);}
function onSegment(p:Point,a:Point,b:Point):boolean{return Math.abs(cross(a,b,p))<1e-7&&p.x>=Math.min(a.x,b.x)-1e-7&&p.x<=Math.max(a.x,b.x)+1e-7&&p.y>=Math.min(a.y,b.y)-1e-7&&p.y<=Math.max(a.y,b.y)+1e-7;}
function intersects(a:Point,b:Point,c:Point,d:Point):boolean{
  return (cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)||onSegment(a,c,d)||onSegment(b,c,d)||onSegment(c,a,b)||onSegment(d,a,b);
}
export function insidePolygon(p:Point,polygon:readonly Point[]):boolean{
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[j],b=polygon[i];if(onSegment(p,a,b))return true;
    if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}
/** Select a whole stroke if its centreline touches or enters the closed lasso. */
export function lassoHits(stroke:InkStroke,polygon:readonly Point[]):boolean{
  if(polygon.length<3)return false;
  if(stroke.points.some(p=>insidePolygon(p,polygon)))return true;
  for(let i=1;i<stroke.points.length;i++)for(let j=0;j<polygon.length;j++)if(intersects(stroke.points[i-1],stroke.points[i],polygon[j],polygon[(j+1)%polygon.length]))return true;
  return false;
}
/** Uniform affine transform also carries the stroke's eraser masks and pen width. */
export function transformStrokes(strokes:readonly InkStroke[],center:Point,dx=0,dy=0,scale=1,angle=0):InkStroke[]{
  if(![center.x,center.y,dx,dy,scale,angle].every(Number.isFinite)||scale<=0)throw new Error('Invalid ink transform');
  const cos=Math.cos(angle),sin=Math.sin(angle);
  const point=<T extends Point>(p:T):T=>({...p,x:center.x+dx+scale*((p.x-center.x)*cos-(p.y-center.y)*sin),y:center.y+dy+scale*((p.x-center.x)*sin+(p.y-center.y)*cos)});
  return strokes.map(s=>({...s,width:s.width*scale,points:s.points.map(point),erasures:s.erasures?.map(e=>({radius:e.radius*scale,points:e.points.map(point)}))}));
}

/** A wider release threshold prevents jitter at the edge of cardinal-angle snapping. */
export function snapRotation(angle:number,previous:number|null=null):{angle:number;locked:number|null}{
  const enter=4*Math.PI/180,leave=7*Math.PI/180;
  if(previous!==null&&Math.abs(angle-previous)<=leave)return {angle:previous,locked:previous};
  const target=Math.round(angle/(Math.PI/2))*Math.PI/2;
  return Math.abs(angle-target)<=enter?{angle:target,locked:target}:{angle,locked:null};
}
