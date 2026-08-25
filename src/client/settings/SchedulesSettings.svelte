<script lang="ts">
import { EmptyState, SettingsPage } from '@kernhq/ui'
import { t } from '../i18n.js'

/**
 * schedules settings.
 *
 * The API behind this is complete — the module's server implements the full surface — but the
 * editing screen is not built yet. Saying so is deliberate: a settings page that renders controls
 * doing nothing is worse than one that admits what it is, and the shell only reaches this route
 * because the capability is on.
 */
</script>

<SettingsPage title={t('settings_schedules')}>
  <EmptyState
    icon="clock"
    title={t('settings_schedules')}
    description={t('settings_not_built')}
  />
</SettingsPage>
