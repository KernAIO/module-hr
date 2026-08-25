<script lang="ts">
import type { WidgetProps } from '@kernhq/ui'
import ClockControls from '../components/ClockControls.svelte'

/** The clock, on the dashboard. The frame belongs to the shell, so this is only the control. */
const { workspaceId }: WidgetProps = $props()
</script>

<ClockControls {workspaceId} />
