export class EditHistory {
  constructor(text = "") { this.reset(text); }
  reset(text) { this.items = [text]; this.index = 0; this.composing = false; }
  begin() { this.composing = true; }
  end(text) { this.composing = false; this.record(text); }
  record(text) {
    if (this.composing || this.items[this.index] === text) return;
    this.items = this.items.slice(0, this.index + 1);
    this.items.push(text);
    if (this.items.length > 200) this.items.shift();
    this.index = this.items.length - 1;
  }
  undo() { if (!this.composing) this.index = Math.max(0, this.index - 1); return this.items[this.index]; }
  redo() { if (!this.composing) this.index = Math.min(this.items.length - 1, this.index + 1); return this.items[this.index]; }
}
