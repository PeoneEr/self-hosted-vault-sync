export class Plugin {
  app: any = {};
  manifest: any = {};
  async loadData(): Promise<any> { return {}; }
  async saveData(_data: any): Promise<void> {}
  addStatusBarItem(): HTMLElement { return document.createElement('div'); }
  registerEvent(_event: any): void {}
  addSettingTab(_tab: any): void {}
}

export class PluginSettingTab {
  containerEl: HTMLElement = document.createElement('div');
  constructor(public app: any, public plugin: any) {}
  display(): void {}
}

export class Setting {
  constructor(_el: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addText(_cb: (t: any) => void): this {
    _cb({ setValue: () => this, setPlaceholder: () => this, onChange: () => this });
    return this;
  }
  addToggle(_cb: (t: any) => void): this {
    _cb({ setValue: () => this, onChange: () => this });
    return this;
  }
  addSlider(_cb: (t: any) => void): this {
    _cb({ setValue: () => this, setLimits: () => this, setDynamicTooltip: () => this, onChange: () => this });
    return this;
  }
  addButton(_cb: (t: any) => void): this {
    _cb({ setButtonText: () => this, onClick: () => this });
    return this;
  }
}

export class Notice {
  constructor(_message: string) {}
}

export const Platform = {
  isMobile: false,
  isDesktop: true,
};

export const requestUrl = jest.fn();
