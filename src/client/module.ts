import { defineClientModule } from '@kernhq/ui'
import { HR_PERMISSIONS } from '../contract/permissions.js'
import { HR_CAPABILITIES } from './capabilities.js'
import { hrMessageBundles, t } from './i18n.js'

/**
 * HR as the shell sees it.
 *
 * Every contribution carries two independent gates, and they answer different questions:
 *
 * - `permission` — may *this person* reach it. Someone else in the workspace may well see it.
 * - `capability` — does *this workspace* have the feature at all. When it is off nobody sees it,
 *   including an owner, and the API behind it answers 404 rather than 403.
 *
 * That second gate is why this module can be a staff directory for one company and a shift-rostering
 * system for another without a line of conditional code. A workspace that never switches attendance
 * on has no clock widget, no attendance nav, no schedule settings and no attendance commands — not
 * greyed out, not there.
 *
 * Labels are getters rather than strings because a module is defined once at import time while the
 * interface language can change afterwards; reading them on render keeps the rail and the palette in
 * the language the person actually chose.
 */
export const hrClientModule = defineClientModule({
  id: 'hr',
  name: 'People',
  icon: 'users',
  messages: hrMessageBundles,

  nav: [
    {
      id: 'hr',
      get label() {
        return t('nav')
      },
      icon: 'users',
      href: '/hr',
      order: 30,
      permission: HR_PERMISSIONS.personView,
    },
  ],

  routes: [
    {
      path: '/hr/leave',
      component: () => import('./pages/LeavePage.svelte'),
      get title() {
        return t('leave_title')
      },
      permission: HR_PERMISSIONS.leaveView,
      capability: HR_CAPABILITIES.leave,
    },
    {
      path: '/hr/attendance',
      component: () => import('./pages/AttendancePage.svelte'),
      get title() {
        return t('attendance_title')
      },
      permission: HR_PERMISSIONS.attendanceView,
      capability: HR_CAPABILITIES.attendance,
    },
    {
      path: '/hr/approvals',
      component: () => import('./pages/ApprovalsPage.svelte'),
      get title() {
        return t('approvals_title')
      },
    },
    {
      path: '/hr/offices',
      component: () => import('./pages/OfficesPage.svelte'),
      get title() {
        return t('offices_title')
      },
      permission: HR_PERMISSIONS.officeView,
      capability: HR_CAPABILITIES.offices,
    },
    {
      path: '/hr/org',
      component: () => import('./pages/OrgPage.svelte'),
      get title() {
        return t('org_title')
      },
      // No capability: departments and positions are part of `core`, and `hr.org.view` is a default
      // member permission — the chart is the one HR screen most of a company opens.
      permission: HR_PERMISSIONS.orgView,
    },
    {
      // Last: the shell matches in order, and `/hr` would otherwise swallow the paths above it.
      path: '/hr',
      component: () => import('./pages/DirectoryPage.svelte'),
      get title() {
        return t('title')
      },
      permission: HR_PERMISSIONS.personView,
    },
  ],

  widgets: [
    {
      id: 'hr.clock',
      get title() {
        return t('widget_clock_title')
      },
      get description() {
        return t('widget_clock_desc')
      },
      icon: 'timer',
      permission: HR_PERMISSIONS.attendancePunch,
      capability: HR_CAPABILITIES.attendance,
      sizes: ['s', 'm'],
      defaultSize: 's',
      compact: true,
      order: 10,
      component: () => import('./widgets/ClockWidget.svelte'),
    },
    {
      id: 'hr.my-leave',
      get title() {
        return t('widget_balance_title')
      },
      get description() {
        return t('widget_balance_desc')
      },
      icon: 'tree-palm',
      permission: HR_PERMISSIONS.leaveView,
      capability: HR_CAPABILITIES.leave,
      sizes: ['s', 'm'],
      defaultSize: 'm',
      order: 20,
      component: () => import('./widgets/LeaveBalanceWidget.svelte'),
    },
    {
      id: 'hr.whos-out',
      get title() {
        return t('widget_whos_out_title')
      },
      get description() {
        return t('widget_whos_out_desc')
      },
      icon: 'calendar-days',
      permission: HR_PERMISSIONS.leaveViewTeam,
      capability: HR_CAPABILITIES.leave,
      sizes: ['m', 'l'],
      defaultSize: 'm',
      order: 30,
      component: () => import('./widgets/WhosOutWidget.svelte'),
    },
    {
      id: 'hr.approvals',
      get title() {
        return t('widget_approvals_title')
      },
      get description() {
        return t('widget_approvals_desc')
      },
      icon: 'check-check',
      sizes: ['s', 'm', 'l'],
      defaultSize: 'm',
      order: 40,
      component: () => import('./widgets/ApprovalsWidget.svelte'),
    },
    {
      id: 'hr.headcount',
      get title() {
        return t('widget_headcount_title')
      },
      get description() {
        return t('widget_headcount_desc')
      },
      icon: 'users',
      permission: HR_PERMISSIONS.personView,
      sizes: ['s'],
      defaultSize: 's',
      compact: true,
      order: 50,
      component: () => import('./widgets/HeadcountWidget.svelte'),
    },
  ],

  commands: [
    {
      id: 'hr.directory',
      get label() {
        return t('cmd_directory')
      },
      icon: 'users',
      permission: HR_PERMISSIONS.personView,
      run: (ctx) => ctx.navigate('/hr'),
    },
    {
      id: 'hr.request-leave',
      get label() {
        return t('cmd_request_leave')
      },
      icon: 'tree-palm',
      permission: HR_PERMISSIONS.leaveRequest,
      capability: HR_CAPABILITIES.leave,
      run: (ctx) => ctx.navigate('/hr/leave?new=1'),
    },
    {
      id: 'hr.my-attendance',
      get label() {
        return t('cmd_attendance')
      },
      icon: 'timer',
      permission: HR_PERMISSIONS.attendanceView,
      capability: HR_CAPABILITIES.attendance,
      run: (ctx) => ctx.navigate('/hr/attendance'),
    },
    {
      id: 'hr.approvals',
      get label() {
        return t('cmd_approvals')
      },
      icon: 'check-check',
      run: (ctx) => ctx.navigate('/hr/approvals'),
    },
  ],

  sidebar: [
    {
      id: 'hr',
      match: ['hr'],
      permission: HR_PERMISSIONS.personView,
      component: () => import('./components/HrSidebar.svelte'),
    },
  ],

  /**
   * Where HR is configured. The shell builds the settings nav from these, and the route is
   * conventional (`/<ws>/settings/hr/<id>`), and the shell mounts whatever is declared here — there
   * is no route file in the app to keep in step with it any more.
   */
  settingsPages: [
    {
      id: 'general',
      get label() {
        return t('settings_general')
      },
      icon: 'sliders-vertical',
      scope: 'workspace',
      permission: 'core.modules.manage',
      order: 1,
      component: () => import('./settings/GeneralSettings.svelte'),
    },
    {
      id: 'capabilities',
      get label() {
        return t('settings_capabilities')
      },
      icon: 'toggle-left',
      scope: 'workspace',
      // `core.modules.manage`, not `core.workspace.manage`: core gates `modules.updateSettings` on
      // the former, and this page's every control is a write to it. Offering the page on the wider
      // permission showed the whole switchboard to somebody the server then refused on each switch.
      permission: 'core.modules.manage',
      order: 5,
      component: () => import('./settings/CapabilitiesSettings.svelte'),
    },
    {
      id: 'offices',
      get label() {
        return t('settings_offices')
      },
      icon: 'building',
      scope: 'workspace',
      permission: HR_PERMISSIONS.officeManage,
      capability: HR_CAPABILITIES.offices,
      order: 10,
      component: () => import('./settings/OfficesSettings.svelte'),
    },
    {
      id: 'calendars',
      get label() {
        return t('settings_calendars')
      },
      icon: 'calendar',
      scope: 'workspace',
      permission: HR_PERMISSIONS.calendarManage,
      capability: HR_CAPABILITIES.calendars,
      order: 20,
      component: () => import('./settings/CalendarsSettings.svelte'),
    },
    {
      id: 'leave',
      get label() {
        return t('settings_leave')
      },
      icon: 'tree-palm',
      scope: 'workspace',
      permission: HR_PERMISSIONS.leaveManage,
      capability: HR_CAPABILITIES.leave,
      order: 30,
      component: () => import('./settings/LeaveSettings.svelte'),
    },
    {
      id: 'schedules',
      get label() {
        return t('settings_schedules')
      },
      icon: 'clock',
      scope: 'workspace',
      permission: HR_PERMISSIONS.attendanceManage,
      capability: HR_CAPABILITIES.attendance,
      order: 40,
      component: () => import('./settings/SchedulesSettings.svelte'),
    },
    {
      // Between leave and schedules, because accrual is how a balance comes to exist and the leave
      // types it credits are the page above it.
      id: 'accrual',
      get label() {
        return t('settings_accrual')
      },
      icon: 'gauge',
      scope: 'workspace',
      permission: HR_PERMISSIONS.policyManage,
      capability: HR_CAPABILITIES.leaveAccrual,
      order: 35,
      component: () => import('./settings/AccrualSettings.svelte'),
    },
    {
      id: 'approvals',
      get label() {
        return t('settings_approvals')
      },
      icon: 'list-checks',
      scope: 'workspace',
      permission: HR_PERMISSIONS.approvalManage,
      capability: HR_CAPABILITIES.approvals,
      order: 50,
      component: () => import('./settings/ApprovalsSettings.svelte'),
    },
    {
      // After approvals rather than beside it: locking a month is the last thing an admin does in a
      // cycle, and it is the one entry here that stops other people's screens changing.
      id: 'periods',
      get label() {
        return t('settings_periods')
      },
      icon: 'lock',
      scope: 'workspace',
      permission: HR_PERMISSIONS.periodManage,
      capability: HR_CAPABILITIES.periods,
      order: 60,
      component: () => import('./settings/PeriodsSettings.svelte'),
    },
  ],

  presenters: [
    {
      type: 'person',
      inline: () => import('./components/PersonInline.svelte'),
      page: (id, workspaceSlug) => `/${workspaceSlug}/hr?person=${encodeURIComponent(id)}`,
    },
  ],
})

export default hrClientModule
