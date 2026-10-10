import type { InkStroke, InkToolState } from "./types";

export interface InkController {
  destroy(): void;
  resize(width: number, height: number): void;
  loadStrokes(strokes: InkStroke[]): void;
  replaceStrokes(strokes: InkStroke[], notify?: boolean, undoSnapshot?: InkStroke[]): void;
  setDisplayScale(scale: number): void;
  getStrokes(): InkStroke[];
  flushPendingStrokes(): void;
  setToolState(patch: Partial<InkToolState>): void;
  getToolState(): InkToolState;
  setInputEnabled(enabled: boolean): void;
  canUndo(): boolean;
  canRedo(): boolean;
  isInputActive(): boolean;
  undo(): void;
  redo(): void;
  clear(): void;
}
