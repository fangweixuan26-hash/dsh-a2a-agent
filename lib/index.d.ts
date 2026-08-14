/**
 * Type declarations for `dsh-a2a-agent`.
 *
 * The plugin consumes services provided by the DeepSeek Harness runtime
 * (webServer, llm, agentDefaultModel). They are typed locally so the package
 * stays self-contained and does not hard-depend on DSH internal packages.
 */

/** A2A Task state (A2A 1.0 subset). */
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown'

/** One A2A message part (text is the only emitted kind). */
export interface A2APart {
  kind: 'text' | 'file' | 'data'
  text?: string
  data?: unknown
}

/** An A2A message. */
export interface A2AMessage {
  kind?: 'message'
  messageId: string
  role: 'user' | 'agent'
  parts: A2APart[]
  contextId?: string
  taskId?: string
  metadata?: Record<string, unknown>
}

/** An A2A artifact produced by a completed task. */
export interface A2AArtifact {
  artifactId: string
  name?: string
  description?: string
  parts: A2APart[]
}

/** An A2A task returned by `message/send` / `tasks/get` / `tasks/cancel`. */
export interface A2ATask {
  id: string
  contextId: string
  status: TaskState
  history: A2AMessage[]
  artifacts: A2AArtifact[]
  metadata?: Record<string, unknown>
}

export interface PluginConfig {
  /** Reserved for future options (e.g. custom agent card, task TTL). */
}

export declare const name: 'dsh-a2a-agent'
export declare const inject: ['webServer']

declare const _default: {
  (ctx: unknown, config?: PluginConfig): void
}

export default _default
