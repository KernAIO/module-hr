<script lang="ts">
import { EmptyState, SettingsPage } from '@kernhq/ui'
import { t } from '../i18n.js'

/**
 * offices settings.
 *
 * The API behind this is complete — the module's server implements the full surface — but the
 * editing screen is not built yet. Saying so is deliberate: a settings page that renders controls
 * doing nothing is worse than one that admits what it is, and the shell only reaches this route
 * because the capability is on.
 */
</script>

<SettingsPage title={t('settings_offices')}>
  <EmptyState
    icon="building"
    title={t('settings_offices')}
    description={t('settings_not_built')}
  />
</SettingsPage>
