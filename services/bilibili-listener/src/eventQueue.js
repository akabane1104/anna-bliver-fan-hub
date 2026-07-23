const { safeErrorCode } = require('./errors');

class BoundedEventQueue {
  constructor({
    maxLength,
    concurrency,
    handler,
    onDepthChange = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout
  }) {
    this.maxLength = maxLength;
    this.concurrency = concurrency;
    this.handler = handler;
    this.onDepthChange = onDepthChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.items = [];
    this.active = 0;
    this.accepting = false;
    this.idleWaiters = new Set();
  }

  get depth() {
    return this.active + this.items.length;
  }

  start() {
    this.accepting = true;
  }

  stopAccepting() {
    this.accepting = false;
  }

  enqueue(item) {
    if (!this.accepting) {
      return { accepted: false, reason: 'queue_stopped' };
    }
    if (this.depth >= this.maxLength) {
      return { accepted: false, reason: 'queue_full' };
    }

    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    this.items.push({ item, resolveCompletion });
    this._notifyDepth();
    this._pump();
    return { accepted: true, completion };
  }

  cancelPending(reason = 'queue_cancelled') {
    const pending = this.items.splice(0);
    for (const entry of pending) {
      entry.resolveCompletion({ status: 'cancelled', reason });
    }
    this._notifyDepth();
    this._resolveIdle();
    return pending.length;
  }

  async drain(timeoutMs) {
    if (this.depth === 0) return { drained: true, remaining: 0 };
    return new Promise((resolve) => {
      const waiter = () => {
        this.clearTimer(timer);
        this.idleWaiters.delete(waiter);
        resolve({ drained: true, remaining: 0 });
      };
      const timer = this.setTimer(() => {
        this.idleWaiters.delete(waiter);
        resolve({ drained: false, remaining: this.depth });
      }, timeoutMs);
      this.idleWaiters.add(waiter);
    });
  }

  _notifyDepth() {
    try {
      this.onDepthChange(this.depth);
    } catch {
      // Queue accounting must not be changed by observers.
    }
  }

  _resolveIdle() {
    if (this.depth !== 0) return;
    for (const waiter of [...this.idleWaiters]) waiter();
  }

  _pump() {
    while (this.active < this.concurrency && this.items.length > 0) {
      const entry = this.items.shift();
      this.active += 1;
      this._notifyDepth();
      Promise.resolve()
        .then(() => this.handler(entry.item))
        .then(
          (result) => entry.resolveCompletion({ status: 'handled', result }),
          (error) => entry.resolveCompletion({
            status: 'failed',
            reason: safeErrorCode(error)
          })
        )
        .finally(() => {
          this.active -= 1;
          this._notifyDepth();
          this._pump();
          this._resolveIdle();
        });
    }
  }
}

module.exports = {
  BoundedEventQueue
};
