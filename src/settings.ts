import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type VaultSyncPlugin from './main';
import { PairingClient, PairedDevice } from './pairing';
import { PairingModal } from './pairingModal';
import { OnboardingModal } from './onboardingWizard';
import { errorMessage } from './errors';

export interface SyncSettings {
  serverUrl: string;
  authToken: string;
  syncInterval: number;
  exclude: string[];
}

export const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: '',
  authToken: '',
  syncInterval: 30,
  exclude: [],
};

// Obsidian's config folder isn't necessarily ".obsidian" (Vault#configDir is
// user-configurable), so this can't be a static default — it's computed once
// the plugin knows the real value, in main.ts's loadSettings().
export function defaultExcludePatterns(configDir: string): string[] {
  return [
    `${configDir}/workspace.json`,
    `${configDir}/workspace-mobile.json`,
  ];
}

export class SyncSettingTab extends PluginSettingTab {
  private newDeviceLabel = '';

  constructor(app: App, private plugin: VaultSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Run setup wizard')
      .setDesc('Re-open the guided setup — e.g. to connect this device to a different vault.')
      .addButton(b => b
        .setButtonText('Run wizard')
        .onClick(() => new OnboardingModal(this.app, this.plugin).open()));

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('e.g. https://obsidian-sync.example.com')
      .addText(t => t
        .setPlaceholder('https://')
        .setValue(this.plugin.settings.serverUrl)
        .onChange(async v => {
          this.plugin.settings.serverUrl = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Auth token')
      .setDesc('Only needed for the first device — pair every device after that from the "devices" section below.')
      .addText(t => t
        .setValue(this.plugin.settings.authToken)
        .onChange(async v => {
          this.plugin.settings.authToken = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync interval (seconds)')
      .addSlider(s => s
        .setLimits(10, 300, 10)
        .setValue(this.plugin.settings.syncInterval)
        .onChange(async v => {
          this.plugin.settings.syncInterval = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Exclude patterns')
      .setDesc('One glob per line. These files will not be synced.')
      .addText(t => t
        .setValue(this.plugin.settings.exclude.join('\n'))
        .onChange(async v => {
          this.plugin.settings.exclude = v.split('\n').map(s => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Initial sync')
      .setDesc('Download all files from server, overwriting local. Server wins.')
      .addButton(b => b
        .setButtonText('Start initial sync')
        .onClick(() => this.plugin.runInitialSync()));

    new Setting(containerEl).setName('Devices').setHeading();

    const devicesListEl = containerEl.createDiv();

    new Setting(containerEl)
      .setName('Pair new device')
      .setDesc('Generates a QR code — scan it with the new device\'s camera to connect it, no typing required.')
      .addText(t => t
        .setPlaceholder('Label, e.g. "phone"')
        .onChange(v => { this.newDeviceLabel = v.trim(); }))
      .addButton(b => b
        .setButtonText('Generate')
        .onClick(async () => {
          if (!this.plugin.settings.serverUrl || !this.plugin.settings.authToken) {
            new Notice('Set a server URL and auth token above first');
            return;
          }
          const label = this.newDeviceLabel || 'unnamed device';
          try {
            const { token } = await this.plugin.pairNewDevice(label);
            new PairingModal(this.app, this.plugin.settings.serverUrl, token, label).open();
            await this.renderDevices(devicesListEl);
          } catch (e) {
            new Notice(`Failed to pair device: ${errorMessage(e)}`);
          }
        }));

    this.renderDevices(devicesListEl).catch(console.error);
  }

  private async renderDevices(container: HTMLElement): Promise<void> {
    container.empty();
    if (!this.plugin.settings.serverUrl || !this.plugin.settings.authToken) {
      container.createEl('p', { text: 'Set a server URL and auth token above first.' });
      return;
    }

    const client = new PairingClient(this.plugin.settings.serverUrl, this.plugin.settings.authToken);
    let devices: PairedDevice[];
    try {
      devices = await client.listDevices();
    } catch (e) {
      container.createEl('p', { text: `Failed to load devices: ${errorMessage(e)}` });
      return;
    }

    for (const device of devices) {
      new Setting(container)
        .setName(device.label)
        .setDesc(`Last seen: ${device.lastSeenAt}`)
        .addButton(b => b
          .setButtonText('Revoke')
          // setWarning (not the newer setDestructive, which needs Obsidian
          // 1.13.0+) is a deliberate choice for compatibility with older
          // mobile builds — see eslint.config.js for the corresponding
          // rule override.
          .setWarning()
          .onClick(async () => {
            try {
              await client.revokeDevice(device.id);
              await this.renderDevices(container);
            } catch (e) {
              new Notice(`Failed to revoke device: ${errorMessage(e)}`);
            }
          }));
    }
  }
}
