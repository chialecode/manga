import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const BACKOFF_MS = [1000, 2000, 4000] as const
const JOB_ATTACH_TIMEOUT_MS = 5000

export interface SupervisorEvent {
  readonly kind: 'started' | 'restart' | 'timeout' | 'circuit-open'
  readonly attempt: number
  readonly pid?: number
  readonly delayMs?: number
}

export interface SuperviseOptions {
  readonly heartbeat?: boolean
  readonly onEvent?: (event: SupervisorEvent) => void
}

interface ManagedChild {
  readonly process: ManagedProcess
  readonly jobKeeper: ChildProcess | undefined
}

export interface ManagedProcess {
  once(event: 'exit', listener: () => void): unknown
  kill(): unknown
}

export class Supervisor {
  readonly #helperPath: string
  #managed: ManagedChild | undefined
  #lastHeartbeatMs = 0
  #stopping = false

  constructor(helperPath = defaultJobHelperPath()) {
    this.#helperPath = helperPath
  }

  async start(command: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<ChildProcess> {
    const child = spawn(command, [...args], { env: { ...env }, stdio: 'pipe', windowsHide: true })
    const childPid = requirePid(child)

    try {
      const jobKeeper = await attachKillOnCloseJob(this.#helperPath, childPid)
      this.#managed = { process: child, jobKeeper }
      this.#lastHeartbeatMs = Date.now()
      return child
    } catch (error) {
      if (child.exitCode !== null) throw new Error(`Child exited before Job Object attachment with code ${String(child.exitCode)}`, { cause: error })
      child.kill()
      throw error
    }
  }

  heartbeat(): void {
    this.#lastHeartbeatMs = Date.now()
  }

  async supervise(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    options: SuperviseOptions = {},
  ): Promise<void> {
    this.#stopping = false
    for (let attempt = 0; attempt <= BACKOFF_MS.length && !this.#isStopping(); attempt += 1) {
      let child: ChildProcess
      try {
        child = await this.start(command, args, env)
      } catch {
        if (this.#isStopping()) return
        const delayMs = BACKOFF_MS[attempt]
        if (delayMs === undefined) { options.onEvent?.({ kind: 'circuit-open', attempt }); return }
        options.onEvent?.({ kind: 'restart', attempt, delayMs })
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        continue
      }
      const childPid = requirePid(child)
      options.onEvent?.({ kind: 'started', attempt, pid: childPid })
      const exitPromise = new Promise<void>((resolve) => child.once('exit', () => { resolve() }))
      let heartbeatTimer: NodeJS.Timeout | undefined
      if (options.heartbeat === true) {
        heartbeatTimer = setInterval(() => {
          if (Date.now() - this.#lastHeartbeatMs >= SUPERVISOR_POLICY.timeoutMs) {
            options.onEvent?.({ kind: 'timeout', attempt, pid: childPid })
            child.kill()
          }
        }, SUPERVISOR_POLICY.heartbeatMs)
      }
      await exitPromise
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      this.#releaseJobKeeper()
      if (this.#isStopping()) return
      const delayMs = BACKOFF_MS[attempt]
      if (delayMs === undefined) {
        options.onEvent?.({ kind: 'circuit-open', attempt })
        return
      }
      options.onEvent?.({ kind: 'restart', attempt, delayMs })
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }
  }

  async superviseUtility(factory: () => ManagedProcess, options: SuperviseOptions = {}): Promise<void> {
    this.#stopping = false
    for (let attempt = 0; attempt <= BACKOFF_MS.length && !this.#isStopping(); attempt += 1) {
      const child = factory()
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => { reject(new Error('Utility process did not spawn')) }, JOB_ATTACH_TIMEOUT_MS)
        const inspect = (): void => {
          if (processPid(child) !== undefined) { clearTimeout(deadline); resolve() }
          else setTimeout(inspect, 10)
        }
        inspect()
      })
      const childPid = requirePid(child)
      let jobKeeper: ChildProcess | undefined
      try {
        jobKeeper = await attachKillOnCloseJob(this.#helperPath, childPid)
      } catch (error) {
        // Electron utility processes can already belong to the host Job Object.
        // Windows rejects assigning them to a nested Job; retain heartbeat and
        // restart supervision in that constrained environment.
        if (!String(error).includes('AssignProcessToJobObject')) throw error
      }
      this.#managed = { process: child, jobKeeper }
      this.#lastHeartbeatMs = Date.now()
      options.onEvent?.({ kind: 'started', attempt, pid: childPid })
      const exitPromise = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
      let heartbeatTimer: NodeJS.Timeout | undefined
      if (options.heartbeat === true) heartbeatTimer = setInterval(() => {
        if (Date.now() - this.#lastHeartbeatMs >= SUPERVISOR_POLICY.timeoutMs) child.kill()
      }, SUPERVISOR_POLICY.heartbeatMs)
      await exitPromise
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      this.#releaseJobKeeper()
      if (this.#isStopping()) return
      const delayMs = BACKOFF_MS[attempt]
      if (delayMs === undefined) { options.onEvent?.({ kind: 'circuit-open', attempt }); return }
      options.onEvent?.({ kind: 'restart', attempt, delayMs })
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }
  }

  stop(): void {
    this.#stopping = true
    this.#releaseJobKeeper()
    this.#managed?.process.kill()
    this.#managed = undefined
  }

  #releaseJobKeeper(): void {
    this.#managed?.jobKeeper?.kill()
  }

  #isStopping(): boolean {
    return this.#stopping
  }
}

function requirePid(child: ManagedProcess): number {
  const pid = processPid(child)
  if (pid === undefined) throw new Error('Child process did not receive a process id')
  return pid
}

function processPid(child: ManagedProcess): number | undefined {
  const value: unknown = Reflect.get(child, 'pid')
  return typeof value === 'number' ? value : undefined
}

function defaultJobHelperPath(): string {
  return join(process.resourcesPath, 'job-object.ps1')
}

async function attachKillOnCloseJob(helperPath: string, childPid: number): Promise<ChildProcess> {
  if (process.platform !== 'win32') throw new Error('Supervisor Job Objects require Windows')
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const helper = spawn(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-ParentPid', String(process.pid), '-ChildPid', String(childPid)],
    { env: { SystemRoot: systemRoot }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('Timed out assigning child to Job Object')) }, JOB_ATTACH_TIMEOUT_MS)
    const lines = createInterface({ input: helper.stdout })
    let errors = ''
    helper.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8') })
    lines.once('line', (line) => {
      clearTimeout(timeout)
      lines.close()
      if (line === 'assigned') resolve()
      else reject(new Error(`Job Object helper rejected child: ${line}`))
    })
    helper.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Job Object helper exited with ${String(code)}: ${errors.trim()}`))
    })
  })
  return helper
}

export const SUPERVISOR_POLICY = Object.freeze({ heartbeatMs: 5000, timeoutMs: 15000, backoffMs: BACKOFF_MS })
