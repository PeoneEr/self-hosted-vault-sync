import { App, Modal } from 'obsidian';

/**
 * Shown when a single pull batch would delete or overwrite an unusually
 * large fraction of the vault's already-known files — a signal that
 * something is wrong server-side rather than a normal edit. Blocks the
 * batch from applying until the user explicitly confirms.
 */
export class MassChangeModal extends Modal {
  private resolve!: (proceed: boolean) => void;
  private settled = false;

  constructor(
    app: App,
    private affected: number,
    private known: number,
  ) {
    super(app);
  }

  waitForChoice(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Unusual sync activity detected' });

    const percent = Math.round((this.affected / this.known) * 100);
    contentEl.createEl('p', {
      text: `The server reports ${this.affected} of your ${this.known} known files ` +
        `(${percent}%) as deleted or changed in a single sync — this looks unusual. ` +
        'Skip this sync and check the server, or apply it anyway?',
    });

    const buttonRow = contentEl.createDiv();
    buttonRow.setCssStyles({ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '12px' });

    const skipButton = buttonRow.createEl('button', { text: 'Skip this sync' });
    skipButton.onclick = () => {
      this.settle(false);
      this.close();
    };

    const applyButton = buttonRow.createEl('button', { text: 'Apply anyway', cls: 'mod-warning' });
    applyButton.onclick = () => {
      this.settle(true);
      this.close();
    };
  }

  onClose(): void {
    // If the modal is dismissed without a button click (Esc, click outside),
    // treat it as declining — applying a mass change silently would defeat
    // the point of asking.
    this.settle(false);
    this.contentEl.empty();
  }

  private settle(proceed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(proceed);
  }
}
