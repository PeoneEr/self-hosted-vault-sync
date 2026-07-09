interface SSEEventPayload {
  path: string;
  action: string;
}

export class SSEClient {
  private source: EventSource | null = null;

  constructor(
    private url: string,
    private token: string,
    private onEvent: (path: string, action: string) => void,
    private onError: () => void,
  ) {}

  connect(): void {
    if (this.source) return;
    // EventSource doesn't support custom headers — pass token as query param
    const sseUrl = `${this.url}/events?token=${encodeURIComponent(this.token)}`;
    this.source = new EventSource(sseUrl);
    this.source.onmessage = (e: MessageEvent) => {
      try {
        // MessageEvent.data is typed `any` (shared with WebSocket, which can
        // carry Blob/ArrayBuffer); EventSource's is always a string per spec.
        const data = JSON.parse(e.data as string) as SSEEventPayload;
        this.onEvent(data.path, data.action);
      } catch { /* ignore malformed events */ }
    };
    this.source.onerror = () => {
      this.disconnect();
      this.onError();
    };
  }

  disconnect(): void {
    this.source?.close();
    this.source = null;
  }

  get connected(): boolean {
    return this.source !== null;
  }
}
