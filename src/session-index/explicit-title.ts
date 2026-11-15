export class ExplicitTitle {
  private named = false;
  private pending = 0;
  private started = 0;

  get active(): boolean {
    return this.named || this.pending > 0;
  }

  get settledByClient(): boolean {
    return this.named && this.pending === 0;
  }

  get renames(): number {
    return this.started;
  }

  reset(): void {
    this.named = false;
  }

  async apply(persist: () => Promise<boolean>): Promise<void> {
    this.pending++;
    this.started++;
    try {
      if (await persist()) this.named = true;
    } finally {
      this.pending--;
    }
  }
}
