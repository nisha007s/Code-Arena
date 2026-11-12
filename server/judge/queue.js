// Bounded priority queue for judge work.
//  - global concurrency limit for practice work
//  - battle submissions (priority 0) run before practice submits (1) and runs (2),
//    and may use `battleSlots` extra slots, so they never wait behind practice jobs
//  - practice work is rejected with `queue_full` beyond maxQueue; battles get a reserve
//  - every task is aborted after jobTimeoutMs
export class QueueError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class JudgeQueue {
  constructor({ concurrency = 2, maxQueue = 16, battleReserve = 6, battleSlots = 2, jobTimeoutMs = 90000 } = {}) {
    Object.assign(this, { concurrency, maxQueue, battleReserve, battleSlots, jobTimeoutMs });
    this.waiting = [];
    this.running = 0;
    this.seq = 0;
  }

  stats() {
    return { waiting: this.waiting.length, running: this.running, concurrency: this.concurrency, battleSlots: this.battleSlots, maxQueue: this.maxQueue };
  }

  /** @param {{priority:number, battle?:boolean, task:(signal:AbortSignal)=>Promise<any>, onStart?:()=>void}} item */
  push({ priority, battle = false, task, onStart }) {
    const limit = this.maxQueue + (battle ? this.battleReserve : 0);
    if (this.waiting.length >= limit) {
      throw new QueueError('queue_full', 'The judge queue is full. Try again in a few seconds.');
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ priority, battle, seq: ++this.seq, task, onStart, resolve, reject });
      this.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.#pump();
    });
  }

  #canStart(item) {
    return this.running < this.concurrency + (item.battle ? this.battleSlots : 0);
  }

  #pump() {
    while (this.waiting.length && this.#canStart(this.waiting[0])) {
      const item = this.waiting.shift();
      this.running++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.jobTimeoutMs);
      timer.unref?.();
      item.onStart?.();
      Promise.resolve()
        .then(() => item.task(ctrl.signal))
        .then(item.resolve, item.reject)
        .finally(() => {
          clearTimeout(timer);
          this.running--;
          this.#pump();
        });
    }
  }
}
