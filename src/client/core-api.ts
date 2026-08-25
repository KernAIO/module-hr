import type { CapabilityDef } from '@kernhq/contracts'

/**
 * The slice of core's API this module reaches for, named by shape rather than imported.
 *
 * A module talks to another module through `kernel.call()` on the server; on the client the shell
 * hands over its own configured core client, and typing the seam structurally keeps the dependency
 * pointing one way — hr does not import core's router type, and core does not know hr exists.
 *
 * Keep it to what is actually called. A wide type here is a promise about core's surface that this
 * module has no standing to make.
 */
export interface CoreApi {
  workspaces: {
    modules: {
      list(input: { workspaceId: string }): Promise<
        Array<{
          manifest: { id: string; capabilities?: CapabilityDef[] }
          state: {
            enabled: boolean
            /** capability ids the server resolved as on — defaults applied, dependencies pruned */
            capabilities?: string[]
            settings?: Record<string, unknown>
          }
        }>
      >
      updateSettings(input: {
        workspaceId: string
        moduleId: string
        settings: Record<string, unknown>
      }): Promise<unknown>
    }
  }
}
