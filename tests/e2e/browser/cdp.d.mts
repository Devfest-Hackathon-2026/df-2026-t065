export interface PageInstance {
  eval<T = unknown>(script: string): Promise<T>;
  goto(url: string): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserInstance {
  exe: string;
  newPage(): Promise<PageInstance>;
  close(): Promise<void>;
}

export function findBrowser(): string;
export function launchBrowser(): Promise<BrowserInstance>;
export function killTree(proc: unknown): void;
export function sleep(ms: number): Promise<void>;
