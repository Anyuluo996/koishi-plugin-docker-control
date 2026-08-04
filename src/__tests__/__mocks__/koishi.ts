/**
 * Koishi mock - 避免真实 koishi 模块的副作用(Logger extends 等)
 */
export class Logger {
  level = 3
  debug() {}
  info() {}
  warn() {}
  error() {}
  trace() {}
  extend(name: string): Logger {
    return new Logger()
  }
  static DEBUG = 4
  static INFO = 3
  static WARN = 2
  static ERROR = 1
}

export class Context {
  model = { extend: () => {} }
  on() { return () => {} }
  command() { return { alias() { return this }, action() { return this }, option() { return this } } }
  get bots() { return [] }
}

export const Random = {
  id: (n: number) => 'test-' + 'x'.repeat(n || 4),
}

export const Schema: any = {
  object: () => chain(),
  string: () => chain(),
  number: () => chain(),
  array: () => chain(),
  boolean: () => chain(),
  union: () => chain(),
  literal: () => chain(),
  dict: () => chain(),
  intersect: () => chain(),
}

function chain(): any {
  const fn: any = () => chain()
  Object.assign(fn, {
    required: () => chain(),
    default: () => chain(),
    description: () => chain(),
    optional: () => chain(),
    returning: () => chain(),
    role: () => chain(),
    min: () => chain(),
    max: () => chain(),
    pattern: () => chain(),
    step: () => chain(),
    hidden: () => chain(),
    experimental: () => chain(),
    deprecated: () => chain(),
  })
  return fn
}
