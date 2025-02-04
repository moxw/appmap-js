// Direct from the Node.js docs
// https://nodejs.org/api/async_context.html#using-asyncresource-for-a-worker-thread-pool

import { AsyncResource } from 'async_hooks';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import assert from 'assert';
import { warn } from 'console';
import { verbose } from '../utils';

const kTaskInfo = Symbol('kTaskInfo');
const kWorkerFreedEvent = Symbol('kWorkerFreedEvent');

type CallbackFn = (err: Error | null, result: any) => void;

type Task = {
  task: any;
  callback: CallbackFn;
};

class WorkerPoolTaskInfo extends AsyncResource {
  constructor(public callback: CallbackFn) {
    super('WorkerPoolTaskInfo');
  }

  done(err: Error, result: any) {
    this.runInAsyncScope(this.callback, null, err, result);
    this.emitDestroy(); // `TaskInfo`s are used only once.
  }
}

export const DEFAULT_ADD_WORKER_DELAY = 5000;

type WorkerInfo = {
  created: Date;
  firstTask?: Date;
};

export default class WorkerPool extends EventEmitter {
  workers: Worker[] = [];
  freeWorkers: Worker[] = [];
  tasks: Task[] = [];
  workerInfoByThreadId: Map<number, WorkerInfo> = new Map();

  addWorkerInterval?: NodeJS.Timeout | undefined;

  constructor(
    public taskFile: string | URL,
    public numThreads: number,
    public addWorkerDelay = DEFAULT_ADD_WORKER_DELAY
  ) {
    super();

    this.addNewWorker();
    if (numThreads > 1) this.addNewWorker();
    if (numThreads > 2) {
      this.addWorkerInterval = setInterval(() => {
        this.addNewWorker();

        if (this.addWorkerInterval && this.workers.length === numThreads)
          clearInterval(this.addWorkerInterval);
      }, addWorkerDelay);
      this.addWorkerInterval.unref();
    }

    const nextTask = (): Task => {
      const task = this.tasks.shift();
      assert(task);
      return task;
    };

    // Any time the kWorkerFreedEvent is emitted, dispatch
    // the next task pending in the queue, if any.
    this.on(kWorkerFreedEvent, () => {
      if (this.tasks.length > 0) {
        const { task, callback } = nextTask();
        this.runTask(task, callback);
      }
    });
  }

  runTask(task: any, callback: CallbackFn) {
    if (this.freeWorkers.length === 0) {
      // No free threads, wait until a worker thread becomes free.
      this.tasks.push({ task, callback });
      return;
    }

    const worker = this.freeWorkers.pop();
    assert(worker);
    worker[kTaskInfo] = new WorkerPoolTaskInfo(callback);
    if (verbose()) warn(`Assigning ${JSON.stringify(task)} to worker thread ${worker.threadId}`);
    worker.postMessage(task);
  }

  async close() {
    if (this.addWorkerInterval) clearInterval(this.addWorkerInterval);

    // Average time between worker creation and first task assignment
    const averageTimeToFirstTask =
      Array.from(this.workerInfoByThreadId.values())
        .filter((info) => info.firstTask)
        .map((info) => info.firstTask!.getTime() - info.created.getTime())
        .reduce((sum, time) => sum + time, 0) / this.workerInfoByThreadId.size;
    if (verbose())
      warn(`Worker average time to first task completion: ${averageTimeToFirstTask}ms`);

    for (const worker of this.workers) await worker.terminate();
  }

  enrollWorker(worker: Worker) {
    this.workerInfoByThreadId.set(worker.threadId, {
      created: new Date(),
    });
  }

  workerTask(worker: Worker) {
    if (this.workerInfoByThreadId.get(worker.threadId)!.firstTask) return;

    this.workerInfoByThreadId.get(worker.threadId)!.firstTask = new Date();
  }

  protected addNewWorker() {
    if (verbose()) warn(`Adding new worker thread`);
    const worker = new Worker(this.taskFile);
    this.enrollWorker(worker);
    worker.on('message', (result) => {
      // In case of success: Call the callback that was passed to `runTask`,
      // remove the `TaskInfo` associated with the Worker, and mark it as free
      // again.
      if (verbose()) warn(`Worker thread ${worker.threadId} finished task`);
      this.workerTask(worker);
      worker[kTaskInfo].done(null, result);
      worker[kTaskInfo] = null;
      this.freeWorkers.push(worker);
      this.emit(kWorkerFreedEvent);
    });
    worker.on('error', (err) => {
      warn(`Uncaught exception in worker thread: ${err}`);
      // In case of an uncaught exception: Call the callback that was passed to
      // `runTask` with the error.
      if (worker[kTaskInfo]) worker[kTaskInfo].done(err, null);
      else this.emit('error', err);
      // Remove the worker from the list and start a new Worker to replace the
      // current one.
      this.workers.splice(this.workers.indexOf(worker), 1);
      this.addNewWorker();
    });
    this.workers.push(worker);
    this.freeWorkers.push(worker);
    this.emit(kWorkerFreedEvent);
  }
}
