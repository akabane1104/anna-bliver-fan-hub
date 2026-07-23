class FakeTimers {
  constructor(now = 1784764800000) {
    this.now = now;
    this.nextId = 1;
    this.tasks = new Map();
    this.clock = this.clock.bind(this);
    this.setTimeout = this.setTimeout.bind(this);
    this.clearTimeout = this.clearTimeout.bind(this);
  }

  clock() {
    return this.now;
  }

  setTimeout(callback, delay = 0) {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, {
      at: this.now + Math.max(0, Number(delay) || 0),
      callback
    });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  async flush() {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  }

  async advance(milliseconds) {
    const target = this.now + milliseconds;
    let steps = 0;
    await this.flush();
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      if (steps >= 100) throw new Error('Fake timer runaway');
      steps += 1;
      const [id, task] = due;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
      await this.flush();
    }
    this.now = target;
    await this.flush();
  }
}

module.exports = {
  FakeTimers
};
