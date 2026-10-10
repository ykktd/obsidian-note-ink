import { Platform } from 'obsidian';

// An iPad remains mobile when a keyboard or mouse changes its primary pointer type.
export function isMobileInkEnvironment(): boolean {
  return Platform.isMobileApp || window.innerWidth <= 820
    || window.matchMedia?.('(pointer: coarse)').matches === true;
}
