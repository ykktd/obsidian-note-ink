import { setIcon } from "obsidian";

export type PdfPageNavigatorPage = {
  pageNumber: number;
  offsetY: number;
  height: number;
};

export type PdfPageNavigatorVisibleRange = {
  top: number;
  bottom: number;
};

type PdfPageNavigatorAction = "toggle" | "first" | "prev" | "next" | "last";

type PdfPageNavigatorOptions = {
  getPages: () => PdfPageNavigatorPage[];
  getVisibleRange: () => PdfPageNavigatorVisibleRange;
  onGoToPage: (pageNumber: number) => void;
};

export class PdfPageNavigatorManager {
  private navEl: HTMLElement | null = null;
  private chipEl: HTMLButtonElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private firstButton: HTMLButtonElement | null = null;
  private prevButton: HTMLButtonElement | null = null;
  private nextButton: HTMLButtonElement | null = null;
  private lastButton: HTMLButtonElement | null = null;
  private updateRaf: number | null = null;
  private collapseTimer: number | null = null;
  private lastActivationAt = 0;
  private currentPageNumber = 1;

  constructor(private readonly options: PdfPageNavigatorOptions) {}

  mount(root: HTMLElement): void {
    const pages = this.options.getPages();
    if (pages.length === 0) return;

    this.detach();

    const nav = root.createDiv({
      cls: "mobile-ink-pdf-page-nav",
      attr: { "aria-label": "PDFのページ移動" }
    });
    this.navEl = nav;
    nav.addEventListener("mousedown", this.onMouseDown, { capture: true });
    nav.addEventListener("touchstart", this.onTouchStart, { capture: true, passive: false });
    nav.addEventListener("click", this.onClickFallback, { capture: true });
    nav.addEventListener("mouseleave", this.onMouseLeave);

    this.firstButton = this.createButton(nav, "chevrons-left", "<<", "最初のページ", "first");
    this.prevButton = this.createButton(nav, "chevron-left", "<", "前のページ", "prev");
    this.chipEl = nav.createEl("button", {
      cls: "mobile-ink-pdf-page-chip",
      attr: {
        type: "button",
        title: "ページ移動",
        "aria-label": "PDFのページ移動",
        "data-page-action": "toggle"
      }
    });

    const input = nav.createEl("input", {
      cls: "mobile-ink-pdf-page-input",
      attr: {
        type: "text",
        inputmode: "numeric",
        autocomplete: "off",
        "aria-label": "PDFのページ番号"
      }
    });
    this.inputEl = input;
    input.addEventListener("pointerdown", this.stopPropagation);
    input.addEventListener("touchstart", this.stopPropagation, { passive: true });
    input.addEventListener("focus", this.onInputFocus);
    input.addEventListener("blur", this.onInputBlur);
    input.addEventListener("keydown", this.onInputKeyDown);

    this.nextButton = this.createButton(nav, "chevron-right", ">", "次のページ", "next");
    this.lastButton = this.createButton(nav, "chevrons-right", ">>", "最後のページ", "last");
    this.updateNow();
  }

  detach(): void {
    if (this.updateRaf !== null) {
      cancelAnimationFrame(this.updateRaf);
      this.updateRaf = null;
    }
    if (this.collapseTimer !== null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }

    this.navEl?.removeEventListener("mousedown", this.onMouseDown, { capture: true });
    this.navEl?.removeEventListener("touchstart", this.onTouchStart, { capture: true });
    this.navEl?.removeEventListener("click", this.onClickFallback, { capture: true });
    this.navEl?.removeEventListener("mouseleave", this.onMouseLeave);
    this.inputEl?.removeEventListener("pointerdown", this.stopPropagation);
    this.inputEl?.removeEventListener("touchstart", this.stopPropagation);
    this.inputEl?.removeEventListener("focus", this.onInputFocus);
    this.inputEl?.removeEventListener("blur", this.onInputBlur);
    this.inputEl?.removeEventListener("keydown", this.onInputKeyDown);

    this.navEl?.remove();
    this.navEl = null;
    this.chipEl = null;
    this.inputEl = null;
    this.firstButton = null;
    this.prevButton = null;
    this.nextButton = null;
    this.lastButton = null;
    this.currentPageNumber = 1;
  }

  setExpanded(expanded: boolean): void {
    this.clearCollapseTimer();
    this.navEl?.classList.toggle("mobile-ink-pdf-page-nav-expanded", expanded);
  }

  scheduleCollapse(delay = 1600): void {
    this.clearCollapseTimer();
    this.collapseTimer = window.setTimeout(() => {
      this.collapseTimer = null;
      const nav = this.navEl;
      if (!nav) return;
      if (document.activeElement === this.inputEl) return;
      if (document.activeElement instanceof HTMLElement && nav.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      nav.classList.remove("mobile-ink-pdf-page-nav-expanded");
    }, delay);
  }

  queueUpdate(): void {
    if (!this.navEl || this.updateRaf !== null) return;
    this.updateRaf = requestAnimationFrame(() => {
      this.updateRaf = null;
      this.updateNow();
    });
  }

  updateNow(): void {
    const pages = this.options.getPages();
    const totalPages = pages.length;
    if (!this.navEl || !this.chipEl || !this.inputEl || totalPages === 0) return;

    const pageNumber = this.computeCurrentPageNumber(pages);
    this.currentPageNumber = pageNumber;
    this.navEl.classList.toggle("mobile-ink-pdf-page-nav-single", totalPages <= 1);
    this.chipEl.textContent = `${pageNumber}/${totalPages}`;
    if (document.activeElement !== this.inputEl) {
      this.inputEl.value = `${pageNumber}/${totalPages}`;
    }

    this.firstButton?.toggleAttribute("disabled", pageNumber <= 1);
    this.prevButton?.toggleAttribute("disabled", pageNumber <= 1);
    this.nextButton?.toggleAttribute("disabled", pageNumber >= totalPages);
    this.lastButton?.toggleAttribute("disabled", pageNumber >= totalPages);
  }

  getCurrentPageNumber(): number {
    const pages = this.options.getPages();
    if (pages.length === 0) return 1;
    return this.navEl ? this.currentPageNumber : this.computeCurrentPageNumber(pages);
  }

  setCurrentPageNumber(pageNumber: number): void {
    const totalPages = Math.max(1, this.options.getPages().length);
    this.currentPageNumber = Math.min(Math.max(Math.floor(pageNumber), 1), totalPages);
  }

  private createButton(parent: HTMLElement, icon: string, fallbackText: string, label: string, action: PdfPageNavigatorAction): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "mobile-ink-pdf-page-nav-button",
      attr: {
        type: "button",
        title: label,
        "aria-label": label,
        "data-page-action": action
      }
    });
    setIcon(button, icon);
    if (!button.querySelector("svg")) {
      button.setText(fallbackText);
    }
    return button;
  }

  private computeCurrentPageNumber(pages: PdfPageNavigatorPage[]): number {
    if (pages.length === 0) return 1;

    const visibleRange = this.options.getVisibleRange();
    const centerY = (visibleRange.top + visibleRange.bottom) / 2;
    let closest = pages[0];
    let closestDistance = Infinity;

    for (const entry of pages) {
      const pageTop = entry.offsetY;
      const pageBottom = entry.offsetY + entry.height;
      if (centerY >= pageTop && centerY <= pageBottom) {
        return entry.pageNumber;
      }

      const pageCenter = (pageTop + pageBottom) / 2;
      const distance = Math.abs(centerY - pageCenter);
      if (distance < closestDistance) {
        closest = entry;
        closestDistance = distance;
      }
    }

    return closest.pageNumber;
  }

  private activate(event: Event, source: "mouse" | "touch" | "click"): void {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".mobile-ink-pdf-page-input")) {
      event.stopPropagation();
      return;
    }

    const actionTarget = event.target.closest<HTMLElement>("[data-page-action]");
    if (!actionTarget) return;

    const now = performance.now();
    if (source === "click" && now - this.lastActivationAt < 420) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    this.lastActivationAt = now;

    event.preventDefault();
    event.stopPropagation();
    this.handleAction(actionTarget.dataset.pageAction ?? "");
  }

  private handleAction(action: string): void {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement !== this.inputEl) {
      activeElement.blur();
    }

    const totalPages = this.options.getPages().length;
    switch (action) {
      case "toggle":
        this.setExpanded(!this.navEl?.classList.contains("mobile-ink-pdf-page-nav-expanded"));
        this.scheduleCollapse(2200);
        return;
      case "first":
        this.inputEl?.blur();
        this.goToPage(1);
        this.scheduleCollapse(700);
        return;
      case "prev":
        this.inputEl?.blur();
        this.goToPage(this.currentPageNumber - 1);
        this.scheduleCollapse(700);
        return;
      case "next":
        this.inputEl?.blur();
        this.goToPage(this.currentPageNumber + 1);
        this.scheduleCollapse(700);
        return;
      case "last":
        this.inputEl?.blur();
        this.goToPage(totalPages);
        this.scheduleCollapse(700);
        return;
    }
  }

  private goToPage(pageNumber: number): void {
    this.setCurrentPageNumber(pageNumber);
    this.options.onGoToPage(this.currentPageNumber);
    this.updateNow();
  }

  private commitInput(): void {
    const input = this.inputEl;
    if (!input) return;

    const pageNumber = this.parseInput(input.value);
    if (pageNumber === null) {
      this.updateNow();
      return;
    }

    this.goToPage(pageNumber);
  }

  private parseInput(value: string): number | null {
    const match = value.trim().match(/\d+/);
    if (!match) return null;

    const page = Number(match[0]);
    if (!Number.isFinite(page)) return null;
    return Math.min(Math.max(Math.floor(page), 1), Math.max(1, this.options.getPages().length));
  }

  private clearCollapseTimer(): void {
    if (this.collapseTimer === null) return;

    window.clearTimeout(this.collapseTimer);
    this.collapseTimer = null;
  }

  private onMouseDown = (event: MouseEvent): void => {
    this.activate(event, "mouse");
  };

  private onTouchStart = (event: TouchEvent): void => {
    this.activate(event, "touch");
  };

  private onClickFallback = (event: MouseEvent): void => {
    this.activate(event, "click");
  };

  private onMouseLeave = (): void => {
    this.scheduleCollapse();
  };

  private stopPropagation = (event: Event): void => {
    event.stopPropagation();
  };

  private onInputFocus = (): void => {
    if (!this.inputEl) return;
    this.setExpanded(true);
    this.inputEl.value = String(this.currentPageNumber);
    this.inputEl.select();
  };

  private onInputBlur = (): void => {
    this.commitInput();
    this.scheduleCollapse(300);
  };

  private onInputKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      this.commitInput();
      this.inputEl?.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.inputEl?.blur();
      this.updateNow();
    }
  };
}
