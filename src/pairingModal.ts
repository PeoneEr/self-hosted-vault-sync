import { App, Modal, Notice } from 'obsidian';
import qrcode from 'qrcode-generator';
import { buildPairingUri } from './pairing';

/**
 * Shows a newly issued device token as a scannable obsidian:// QR code plus
 * a copyable link. Scanning with the phone's system camera app surfaces an
 * "Open in Obsidian" prompt (standard OS handling of a recognized app URI
 * scheme) — no manual token entry on the new device.
 */
export class PairingModal extends Modal {
  constructor(
    app: App,
    private serverUrl: string,
    private token: string,
    private label: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Pair "${this.label}"` });

    const uri = buildPairingUri(this.serverUrl, this.token, this.label);

    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    const qrContainer = contentEl.createDiv();
    // Parse the library's SVG string into a real node rather than assigning
    // innerHTML — Obsidian's plugin review flags innerHTML/outerHTML usage.
    const svgDoc = new DOMParser().parseFromString(
      qr.createSvgTag({ cellSize: 4, margin: 4 }),
      'image/svg+xml',
    );
    qrContainer.appendChild(activeDocument.importNode(svgDoc.documentElement, true));

    contentEl.createEl('p', {
      text: "Scan with your phone's camera app, or copy the link below and open it on the new device:",
    });

    const linkBox = contentEl.createEl('input', { type: 'text' });
    linkBox.value = uri;
    linkBox.readOnly = true;
    linkBox.setCssStyles({ width: '100%' });

    const copyButton = contentEl.createEl('button', { text: 'Copy link' });
    copyButton.onclick = () => {
      navigator.clipboard.writeText(uri)
        .then(() => new Notice('Pairing link copied'))
        .catch(() => new Notice('Copy failed — select and copy the link manually'));
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
