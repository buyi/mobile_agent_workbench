export interface ContractIssue {
  readonly code: string
  readonly path: string
  readonly message: string
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: ReadonlyArray<ContractIssue> }

export const issue = (code: string, path: string, message: string): ContractIssue => ({ code, path, message })

/** Returns the nodes of a cycle in `edges` (adjacency by id), or undefined if acyclic. */
export function findCycle(ids: Iterable<string>, edges: (id: string) => Iterable<string>): string[] | undefined {
  const state = new Map<string, "visiting" | "done">()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    const seen = state.get(id)
    if (seen === "done") return
    if (seen === "visiting") return stack.slice(stack.indexOf(id)).concat(id)
    state.set(id, "visiting")
    stack.push(id)
    for (const next of edges(id)) {
      const cycle = visit(next)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(id, "done")
  }
  for (const id of ids) {
    const cycle = visit(id)
    if (cycle) return cycle
  }
}

export function duplicates(values: Iterable<string>): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const value of values) (seen.has(value) ? dup : seen).add(value)
  return [...dup]
}
