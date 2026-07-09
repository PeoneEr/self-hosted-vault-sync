import { App, ButtonComponent, Modal, Setting } from 'obsidian';
import type VaultSyncPlugin from './main';
import { HttpError, PairingClient, parsePastedPairingLink } from './pairing';
import { errorMessage } from './errors';

type WizardStep = 'choice' | 'new-server' | 'join-existing';

/**
 * First-run (and re-runnable, via Settings) setup flow. Replaces raw
 * Server URL / Auth token fields with a guided choice between setting up
 * a brand-new server (first device) and joining an already-synced setup
 * (every device after that) — see .superpowers/specs/2026-07-08-onboarding-wizard-design.md.
 */
export class OnboardingModal extends Modal {
  private step: WizardStep = 'choice';

  constructor(app: App, private plugin: VaultSyncPlugin) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (this.step === 'choice') this.renderChoice(contentEl);
    else if (this.step === 'new-server') this.renderNewServer(contentEl);
    else this.renderJoinExisting(contentEl);
  }

  private renderChoice(contentEl: HTMLElement): void {
    contentEl.createEl('h2', { text: 'Set up vault sync' });

    new Setting(contentEl)
      .setName('New server setup')
      .setDesc('This is my first device — I just deployed a fresh server.')
      .addButton(b => b
        .setButtonText('Start')
        .onClick(() => { this.step = 'new-server'; this.render(); }));

    new Setting(contentEl)
      .setName('Join existing setup')
      .setDesc('I already sync other devices — connect this one to them.')
      .addButton(b => b
        .setButtonText('Start')
        .onClick(() => { this.step = 'join-existing'; this.render(); }));
  }

  private renderNewServer(contentEl: HTMLElement): void {
    contentEl.createEl('h2', { text: 'New server setup' });

    let serverUrl = this.plugin.settings.serverUrl;
    let authToken = '';

    new Setting(contentEl)
      .setName('Server URL')
      .setDesc('e.g. https://obsidian-sync.example.com')
      .addText(t => t
        .setPlaceholder('https://')
        .setValue(serverUrl)
        .onChange(v => { serverUrl = v.trim(); }));

    new Setting(contentEl)
      .setName('Bootstrap token')
      .setDesc('Shown once in the server logs on first boot.')
      .addText(t => t
        .onChange(v => { authToken = v.trim(); }));

    this.renderConnectRow(contentEl, (statusEl, connectButton) =>
      this.attemptConnect(serverUrl, authToken, connectButton, statusEl));
  }

  private renderJoinExisting(contentEl: HTMLElement): void {
    contentEl.createEl('h2', { text: 'Join existing setup' });
    contentEl.createEl('p', {
      text: 'On an already-set-up device: Settings → Devices → "Pair new device" → '
        + "scan the QR with your phone's camera, or copy the link.",
    });

    let pastedLink = '';

    new Setting(contentEl)
      .setName('Paste pairing link')
      .addText(t => t
        .setPlaceholder('obsidian://self-hosted-vault-sync?...')
        .onChange(v => { pastedLink = v; }));

    this.renderConnectRow(contentEl, (statusEl, connectButton) => {
      const parsed = parsePastedPairingLink(pastedLink);
      if (!parsed) {
        statusEl.setText("That doesn't look like a pairing link");
        return;
      }
      this.attemptConnect(parsed.server, parsed.token, connectButton, statusEl);
    });
  }

  /**
   * Shared Back/Connect button row + status line used by both leaf steps.
   * onConnect receives the status line and Connect button directly (rather
   * than the caller closing over them) since both are created here, after
   * the caller's own local state is already captured in its closure.
   */
  private renderConnectRow(
    contentEl: HTMLElement,
    onConnect: (statusEl: HTMLElement, connectButton: ButtonComponent) => void,
  ): void {
    const statusEl = contentEl.createEl('p', { text: '' });
    let connectButton!: ButtonComponent;

    new Setting(contentEl)
      .addButton(b => b
        .setButtonText('Back')
        .onClick(() => { this.step = 'choice'; this.render(); }))
      .addButton(b => {
        connectButton = b;
        b.setButtonText('Connect').setCta().onClick(() => onConnect(statusEl, connectButton));
        return b;
      });
  }

  private attemptConnect(
    serverUrl: string,
    authToken: string,
    connectButton: ButtonComponent,
    statusEl: HTMLElement,
  ): void {
    if (!serverUrl || !authToken) {
      statusEl.setText('Fill in both fields first');
      return;
    }

    connectButton.setDisabled(true);
    statusEl.setText('Checking connection…');

    new PairingClient(serverUrl, authToken).listDevices()
      .then(async () => {
        this.close();
        await this.plugin.connectToServer(serverUrl, authToken);
      })
      .catch((e: unknown) => {
        connectButton.setDisabled(false);
        statusEl.setText(this.classifyConnectionError(e));
      });
  }

  private classifyConnectionError(e: unknown): string {
    if (e instanceof HttpError) {
      if (e.status === 401 || e.status === 403) {
        return 'Server rejected the token. Check you copied it correctly.';
      }
      return `Server error (HTTP ${e.status}). Try again.`;
    }
    return `Couldn't reach the server. Check the URL and that it's running. (${errorMessage(e)})`;
  }
}
