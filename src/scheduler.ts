/**
 * A long-running task that yields to the Scheduler by awaiting on
 * TaskContext.prototype.nextTick(). Returns a Promise that resolves when the
 * task is complete.
 */
export type TaskFunction<T> = (taskContext: TaskContext) => Promise<T>;

/**
 * Maintains a set of queues, each with their own QueueScheduler to schedule
 * task execution.
 */
export class Scheduler {
  private _queues = new Map<string, TaskQueue>();

  addQueue(name: string, scheduler: QueueScheduler) {
    const queue = new TaskQueue(scheduler);
    this._queues.set(name, queue);
  }

  /**
   * Schedule a task on a named queue. The queue must already exist via a call
   * to `addQueue`.
   * 
   * TODO: Accept a CancelToken
   */
  scheduleTask<T>(queueName: string, task: TaskFunction<T>): Promise<T> {
    const queue = this._queues.get(queueName);
    if (queue == null) {
      throw new Error(`No queue named ${queueName}`);
    }
    return queue.scheduleTask(task);
  }
}

export class TaskQueue {
  name: string;
  tasks = new Set<Task<any>>();
  scheduler: QueueScheduler;

  constructor(scheduler: QueueScheduler) {
    this.scheduler = scheduler;
  }

  scheduleTask<T>(taskFn: TaskFunction<T>): Promise<T> {
    const task = new Task(taskFn, this);
    this.tasks.add(task);
    this.scheduler.schedule(this);
    return task._completed;
  }

  removeTask(task: Task<any>) {
    console.assert(task._queue === this);
    this.tasks.delete(task);
  }
}

/**
 * An object that controls when tasks are executed from a queue or set of queues.
 */
export interface QueueScheduler {
  schedule(queue: TaskQueue): void;
}

export abstract class BaseQueueScheduler {
  protected _queues = new Set<TaskQueue>();
  protected _queueIterator: Iterator<TaskQueue>;
  protected _queueData = new WeakMap<TaskQueue, any>();
  protected _taskData = new  WeakMap<Task<any>, any>();

  protected _callbackId = 0;

  protected _nextQueue: TaskQueue | null;
  nextTask: Task<any> | null;

  constructor() {
    this._queueIterator = this._queues.values();
  }

  schedule(queue: TaskQueue): void {
    this._queues.add(queue);
    if (!this._queueData.has(queue)) {
      this._queueData.set(queue, {
        taskIterator: queue.tasks.values(),
      });
    }
    if (this.nextTask == null) {
      this.advanceTask();
    }
    if (this.nextTask != null && this._callbackId === 0) {
      this._callbackId = this._schedule();
    }
  }

  private _advanceQueue() {
    if (this._queues.size === 0) {
      this._nextQueue = null;
      return;
    }
    let next = this._queueIterator.next();
    if (next.done) {
      // Reached the end of the queues iterator, start from beginning
      this._queueIterator = this._queues.values();
      next = this._queueIterator.next();
    }
    console.assert(!next.done);
    this._nextQueue = next.value;
  }

  advanceTask() {
    this._advanceQueue();
    const queue = this._nextQueue;
    if (queue == null) {
      this.nextTask = null;
      return;
    }
    if (queue.tasks.size === 0) {
      this.nextTask = null;
      return;
    }
    const queueData = this._queueData.get(queue);
    let next = queueData.taskIterator.next();
    if (next.done) {
      queueData.taskIterator = queue.tasks.values();
      next = queueData.taskIterator.next();
    }
    console.assert(!next.done);
    this.nextTask = next.value;
  }

  getTaskData(task: Task<any>) {
    let taskData = this._taskData.get(task);
    if (taskData == null) {
      taskData = {
        tickCount: 0,
        avgTickDuration: 0,
      };
      this._taskData.set(task, taskData);
    }
    return taskData;
  }

  /**
   * Schedule a new callback of _execute. Returns a callback id.
   */
  protected abstract _schedule(): number;

  protected async _execute(initialTimeRemaining: number) {
    console.log(`BaseQueueScheduler._execute ${initialTimeRemaining}`);
    // Mark that we don't have a scheduled callback
    this._callbackId = 0;
    const estimatedEnd = performance.now() + initialTimeRemaining;
    let tasksExecuted = 0;
    while (this.nextTask) {
      const task = this.nextTask;
      const taskData = this.getTaskData(task);
      const start = performance.now();
      const timeRemaining = estimatedEnd - start;
      // Always execute at least one task, or if we think there's enough time left in the frame
      if (tasksExecuted === 0 || timeRemaining >= taskData.avgTickDuration) {
        tasksExecuted++;
        this.advanceTask();
        const done = await task._continue();
        const end = performance.now();
        const duration = end - start;
        taskData.avgTickDuration = (taskData.avgTickDuration * taskData.tickCount + duration) / ++taskData.tickCount;
        if (done) {
          // clean up task
          const queue = task._queue;
          queue.removeTask(task);
          if (this.nextTask === task) {
            this.advanceTask();
          }
        }
      } else {
        break;
      }
    }
    if (this.nextTask != null && this._callbackId === 0) {
      this._callbackId = this._schedule();
    }
  }

}

/**
 * A QueueScheduler that uses requestAnimationFrame timing.
 * 
 * This scheduler tries to fit in as many task ticks as will fit in a frame. It
 * remembers the average time a tick takes per task and only executes a tick if it
 * thinks it'll fit in the remaining frame budget. It's a very simple estimate and
 * doesn't try to fit in faster tasks if a long one is next, so slow tasks can starve
 * fast ones.
 */
export class AnimationFrameQueueScheduler extends BaseQueueScheduler {

  /**
   * Time allocated to script execution per frame, in ms.
   */
  private _frameBudget: number;

  constructor(frameBudget: number = 12) {
    super();
    this._frameBudget = frameBudget;
  }

  protected _schedule() {
    return requestAnimationFrame((frameStart: number) => {
      const timeRemaining = this._frameBudget + frameStart - performance.now();
      this._execute(timeRemaining);
    });
  }
}

declare global {
  interface IdleDeadline {
    timeRemaining(): number;
    didTimeout: boolean;
  }
  interface Window {
    requestIdleCallback(callback: (deadline: IdleDeadline) => void): number;
  }
}

/**
 * A QueueScheduler that uses requestIdleCallback timing.
 * 
 * This scheduler tries to fit in as many task ticks as will fit under the extimated
 * time that the UA expects the user to remain idle.
 */
export class IdleQueueScheduler extends BaseQueueScheduler {
  protected _schedule(): number {
    return window.requestIdleCallback((deadline) => {
      this._execute(deadline.timeRemaining());
    });
  }
}

export class Task<T> {
  _taskFn: TaskFunction<T>;
  _queue: TaskQueue;
  _completed: Promise<T>;
  _resolveCompleted: (v: T) => void;
  _rejectCompleted: (err: any) => void;
  _context: TaskContext|null;
  _isComplete = false;
  _isCanceled = false;

  constructor(taskFn: TaskFunction<T>, queue: TaskQueue) {
    this._taskFn = taskFn;
    this._queue = queue;
    this._completed = new Promise((resolve, reject) => {
      this._resolveCompleted = resolve;
      this._rejectCompleted = reject;
    });
  }

  get completed(): Promise<T> {
    return this._completed;
  }

  /**
   * Continues or starts this task.
   *
   * _continue() starts a task function by invoking it, and continues a task by
   * resolving the Promise returned from the last TaskContext.nextTick() call.
   * 
   * Returns a Promise that resolves when the task yields.
   */
  async _continue(): Promise<boolean> {
    if (this._context == null) {
      this._context = new TaskContext();
      // We haven't started the task, so invoke the task function.
      (async () => {
        try {
          // force task start to wait so we can await it yielding first
          await Promise.resolve();
          const result = await this._taskFn.call(null, this._context);
          this._resolveCompleted(result);
        } catch (e) {
          this._rejectCompleted(e);
        } finally {
          // Cleanup

          // _continue() is waiting on _context.yielded, so resolve it to keep going
          this._context!._yield(true);
        }
      })();
    } else {
      // The task is started and has called TaskContext.nextTick()
      const context = this._context;
      console.assert(context._continue != null);
      console.assert(context._cancel != null);
      const _continue = context._continue;
      context._continue = null;
      context._cancel = null;
      _continue!();
    }
    // Wait till the task yields
    return this._context._yielded;
  }

  cancel() {
    console.assert(this._isCanceled === false);
    if (this._context == null) {
      this._isCanceled = true;
    } else {
      // The task is started and has called TaskContext.nextTick()
      const context = this._context;
      console.assert(context._continue != null);
      console.assert(context._cancel != null);
      const _cancel = context._cancel;
      context._continue = null;
      context._cancel = null;
      // Rejects the Promise returned from the last TaskContext.nextTick() call
      // This should in turn reject or resolve the Promise returned by the task
      // function. If not it means the task caught the CancelError and ignored it.
      // If we can detect that case we should reject the _completed Promise via
      // _rejectCompleted().
      _cancel!(new Error('Task canceled'));
    }
  }
}

export class TaskContext {
  _continue: (() => void) | null;
  _cancel: ((error?: any) => void) | null;
  _yielded: Promise<boolean>;
  _yield: ((done: boolean) => void);
  _error: ((error?: any) => void);

  constructor() {
    this._yielded = new Promise<boolean>((resolve, reject) => {
      this._yield = resolve;
      this._error = reject;
    });
  }

  /**
   * Yields control back to the scheduler. Returns a Promise that resolves when
   * the scheduler continues the task, or rejects if the scheduler cancels the task.
   */
  nextTick(): Promise<void> {
    console.assert(this._continue == null);
    console.assert(this._cancel == null);
    const _yield = this._yield;
    this._yielded = new Promise<boolean>((resolve, reject) => {
      this._yield = resolve;
      this._error = reject;
    });
    _yield(false);
    return new Promise<void>((resolve, reject) => {
      this._continue = resolve;
      this._cancel = reject;
    });
  }

}
