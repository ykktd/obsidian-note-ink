import type { InkStroke } from './types';

export type IndexedStroke = { index: number; stroke: InkStroke };
export type StrokeChange = { removed: IndexedStroke[]; added: IndexedStroke[] };

export function sameStroke(a: InkStroke, b: InkStroke): boolean {
  if (a === b) return true;
  const ae=a.erasures??[],be=b.erasures??[];
  if(ae!==be && (ae.length!==be.length || ae.some((e,i)=>e.radius!==be[i].radius || e.points.length!==be[i].points.length || e.points.some((p,j)=>p.x!==be[i].points[j].x||p.y!==be[i].points[j].y))))return false;
  return a.id === b.id && a.tool === b.tool && a.color === b.color && a.width === b.width
    && a.points.length === b.points.length && a.points.every((p,i) => {
      const q = b.points[i];
      return p.x === q.x && p.y === q.y && p.t === q.t && p.pressure === q.pressure
        && p.tiltX === q.tiltX && p.tiltY === q.tiltY;
    });
}

/** Committed strokes are immutable; history owns only changed stroke references. */
export function strokeChange(before: readonly InkStroke[], after: readonly InkStroke[]): StrokeChange {
  const old = new Map(before.map((stroke,index) => [stroke.id,{stroke,index}]));
  const next = new Map(after.map((stroke,index) => [stroke.id,{stroke,index}]));
  const commonBefore = before.filter(s => next.has(s.id)).map(s => s.id);
  const commonAfter = after.filter(s => old.has(s.id)).map(s => s.id);
  const reordered = commonBefore.some((id,i) => id !== commonAfter[i]);
  return {
    removed: before.flatMap((stroke,index) => reordered || !next.has(stroke.id) || !sameStroke(stroke,next.get(stroke.id)!.stroke) ? [{stroke,index}] : []),
    added: after.flatMap((stroke,index) => reordered || !old.has(stroke.id) || !sameStroke(stroke,old.get(stroke.id)!.stroke) ? [{stroke,index}] : [])
  };
}

export function applyStrokeChange(strokes: readonly InkStroke[], change: StrokeChange, forward = true): InkStroke[] {
  const remove = forward ? change.removed : change.added;
  const insert = forward ? change.added : change.removed;
  const ids = new Set(remove.map(entry => entry.stroke.id));
  const result = strokes.filter(stroke => !ids.has(stroke.id));
  for (const {index,stroke} of [...insert].sort((a,b) => a.index-b.index)) result.splice(index,0,stroke);
  return result;
}

export class StrokeHistory {
  private undoEntries: StrokeChange[] = [];
  private redoEntries: StrokeChange[] = [];
  get canUndo(): boolean { return this.undoEntries.length > 0; }
  get canRedo(): boolean { return this.redoEntries.length > 0; }
  reset(): void { this.undoEntries = []; this.redoEntries = []; }
  record(change: StrokeChange): void {
    if (!change.removed.length && !change.added.length) return;
    this.undoEntries.push(change);
    if (this.undoEntries.length > 40) this.undoEntries.shift();
    this.redoEntries = [];
  }
  undo(): StrokeChange | undefined { const c=this.undoEntries.pop(); if(c)this.redoEntries.push(c); return c; }
  redo(): StrokeChange | undefined { const c=this.redoEntries.pop(); if(c)this.undoEntries.push(c); return c; }
}
