/**
 * The in-memory HR API.
 *
 * A module missing from the mock has working pages and no way to reach them in exactly the
 * environment used for demos and end-to-end tests — so this exists to be *reachable*, not to be a
 * second implementation. It answers the shapes the screens ask for, with data a demo can show.
 */
const now = Date.now()
const iso = (msAgo = 0) => new Date(now - msAgo).toISOString()
const day = (offset: number) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10)

const OFFICES = [
  {
    id: '01920000-0000-7000-8000-00000000e001',
    name: 'Istanbul',
    country: 'TR',
    timezone: 'Europe/Istanbul',
    isDefault: true,
    kind: 'head_office',
  },
  {
    id: '01920000-0000-7000-8000-00000000e002',
    name: 'Amsterdam',
    country: 'NL',
    timezone: 'Europe/Amsterdam',
    isDefault: false,
    kind: 'branch',
  },
]

const PEOPLE = [
  {
    id: '01920000-0000-7000-8000-00000000d001',
    displayName: 'Ayşe Yılmaz',
    workEmail: 'ayse@example.test',
    status: 'active',
    timezone: 'Europe/Istanbul',
    officeId: OFFICES[0]!.id,
    employeeNo: 'E-1',
  },
  {
    id: '01920000-0000-7000-8000-00000000d002',
    displayName: 'Sanne de Vries',
    workEmail: 'sanne@example.test',
    status: 'active',
    timezone: 'Europe/Amsterdam',
    officeId: OFFICES[1]!.id,
    employeeNo: 'E-2',
  },
  {
    id: '01920000-0000-7000-8000-00000000d003',
    displayName: 'Mehmet Kaya',
    workEmail: 'mehmet@example.test',
    status: 'on_leave',
    timezone: 'Europe/Istanbul',
    officeId: OFFICES[0]!.id,
    employeeNo: 'E-3',
  },
]

const person = (p: (typeof PEOPLE)[number], workspaceId: string) => ({
  ...p,
  workspaceId,
  userId: null,
  personalEmail: null,
  phone: null,
  photoFileId: null,
  hiredOn: day(-400),
  terminatedOn: null,
  custom: {},
  createdAt: iso(400 * 86_400_000),
  updatedAt: iso(),
})

export function createMockHrApi() {
  /** Clock state lives here so the widget behaves across clicks in a demo. */
  let clockedInAt: number | null = null
  let onBreak = false

  const delegations: Array<Record<string, unknown>> = []

  const approvalRequests = [
    {
      id: '01920000-0000-7000-8000-00000000f001',
      workspaceId: '',
      subjectType: 'leave' as const,
      subjectId: '01920000-0000-7000-8000-00000000c001',
      summary: `5 day(s) from ${day(14)}`,
      summaryParams: { days: 5, from: day(14), to: day(18) } as Record<string, string | number> | null,
      status: 'pending' as string,
      currentStep: 0,
      requestedBy: null,
      requesterPersonId: PEOPLE[1]!.id,
      requesterName: PEOPLE[1]!.displayName,
      requestedAt: iso(3600_000),
      decidedAt: null as string | null,
      steps: [] as Array<Record<string, unknown>>,
    },
    {
      id: '01920000-0000-7000-8000-00000000f002',
      subjectType: 'regularization' as const,
      workspaceId: '',
      subjectId: '01920000-0000-7000-8000-00000000c002',
      summary: `Correction for ${day(-1)}`,
      summaryParams: { date: day(-1) } as Record<string, string | number> | null,
      status: 'pending' as string,
      currentStep: 0,
      requestedBy: null,
      requesterPersonId: PEOPLE[2]!.id,
      requesterName: PEOPLE[2]!.displayName,
      requestedAt: iso(7200_000),
      decidedAt: null as string | null,
      steps: [{ stepIndex: 0 }, { stepIndex: 1 }] as Array<Record<string, unknown>>,
    },
    {
      id: '01920000-0000-7000-8000-00000000f003',
      workspaceId: '',
      subjectType: 'leave' as const,
      subjectId: '01920000-0000-7000-8000-00000000c003',
      summary: `1 day(s) from ${day(-20)}`,
      summaryParams: { days: 1, from: day(-20), to: day(-20) } as Record<string, string | number> | null,
      status: 'approved' as string,
      currentStep: 0,
      requestedBy: null,
      requesterPersonId: PEOPLE[0]!.id,
      requesterName: PEOPLE[0]!.displayName,
      requestedAt: iso(20 * 86_400_000),
      decidedAt: iso(19 * 86_400_000) as string | null,
      steps: [] as Array<Record<string, unknown>>,
    },
  ]

  const leaveRequests: Array<Record<string, unknown>> = [
    {
      id: '01920000-0000-7000-8000-00000000c001',
      workspaceId: '',
      personId: PEOPLE[0]!.id,
      leaveTypeId: '01920000-0000-7000-8000-00000000b001',
      startsOn: day(14),
      endsOn: day(18),
      startPart: 'full',
      endPart: 'full',
      hours: null,
      workingDays: 5,
      minutes: 5 * 480,
      status: 'pending',
      reason: null,
      documentFileId: null,
      approvalRequestId: null,
      decidedAt: null,
      createdAt: iso(),
      updatedAt: iso(),
    },
  ]

  return {
    people: {
      list: async ({ workspaceId, q, officeId }: { workspaceId: string; q?: string; officeId?: string }) => {
        let items = PEOPLE
        if (officeId) items = items.filter((p) => p.officeId === officeId)
        if (q) items = items.filter((p) => p.displayName.toLowerCase().includes(q.toLowerCase()))
        // Carries officeName too: a mock that answers a different shape from core is how a screen
        // works in `dev:mock` and breaks against the real API.
        return {
          items: items.map((p) => ({
            ...person(p, workspaceId),
            officeId: p.officeId,
            officeName: OFFICES.find((o) => o.id === p.officeId)?.name ?? null,
          })),
          nextCursor: null,
          total: items.length,
        }
      },
      get: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) => {
        const found = PEOPLE.find((p) => p.id === personId) ?? PEOPLE[0]!
        return person(found, workspaceId)
      },
      me: async ({ workspaceId }: { workspaceId: string }) => person(PEOPLE[0]!, workspaceId),
      create: async (input: {
        workspaceId: string
        displayName: string
        workEmail?: string | null
        employeeNo?: string | null
        hiredOn?: string | null
        officeId?: string | null
        employmentType?: string
      }) => {
        const added = {
          id: crypto.randomUUID(),
          displayName: input.displayName,
          workEmail: input.workEmail ?? '',
          status: 'active' as const,
          timezone: 'Europe/Istanbul',
          officeId: input.officeId ?? OFFICES[0]!.id,
          employeeNo: input.employeeNo ?? `E-${PEOPLE.length + 1}`,
        }
        PEOPLE.push(added)
        return person(added, input.workspaceId)
      },
      update: async (input: {
        workspaceId: string
        personId: string
        displayName?: string
        workEmail?: string | null
        personalEmail?: string | null
        phone?: string | null
      }) => {
        const found = PEOPLE.find((p) => p.id === input.personId) ?? PEOPLE[0]!
        if (input.displayName) found.displayName = input.displayName
        if (input.workEmail !== undefined) found.workEmail = input.workEmail ?? ''
        return {
          ...person(found, input.workspaceId),
          personalEmail: input.personalEmail ?? null,
          phone: input.phone ?? null,
        }
      },
      offboard: async (input: { workspaceId: string; personId: string; on: string }) => {
        const found = PEOPLE.find((p) => p.id === input.personId) ?? PEOPLE[0]!
        return { ...person(found, input.workspaceId), terminatedOn: input.on, status: 'terminated' as const }
      },
    },

    employment: {
      current: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) => ({
        id: '01920000-0000-7000-8000-00000000ee01',
        workspaceId,
        personId,
        effectiveFrom: day(-400),
        effectiveTo: null,
        orgUnitId: null,
        positionId: null,
        legalEntityId: null,
        costCenterId: null,
        managerPersonId: PEOPLE[1]?.id ?? null,
        employmentType: 'full_time' as const,
        fte: 1,
        contractHoursWeek: 40,
        reason: null,
        createdAt: iso(),
      }),
    },

    offices: {
      list: async ({ workspaceId }: { workspaceId: string }) =>
        OFFICES.map((o) => ({
          ...o,
          workspaceId,
          code: null,
          parentOfficeId: null,
          legalEntityId: null,
          region: null,
          city: o.name,
          calendarId: null,
          address: null,
          headPersonId: null,
          archivedAt: null,
          createdAt: iso(),
          headcount: PEOPLE.filter((p) => p.officeId === o.id).length,
        })),
      resolveFor: async ({ workspaceId, personId }: { workspaceId: string; personId: string }) => {
        const p = PEOPLE.find((x) => x.id === personId) ?? PEOPLE[0]!
        const office = OFFICES.find((o) => o.id === p.officeId) ?? OFFICES[0]!
        void workspaceId
        return {
          personId: p.id,
          on: day(0),
          primaryOfficeId: office.id,
          primaryOfficeName: office.name,
          otherOfficeIds: [],
          country: office.country,
          timezone: office.timezone,
          timezoneFrom: 'office' as const,
          calendarId: null,
          calendarFrom: null,
          workingWeek: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 },
          legalEntityId: null,
          orgUnitId: null,
          orgUnitPath: null,
          managerPersonId: PEOPLE[1]!.id,
        }
      },
    },

    leave: {
      types: {
        list: async ({ workspaceId }: { workspaceId: string }) => [
          {
            id: '01920000-0000-7000-8000-00000000b001',
            workspaceId,
            key: 'annual',
            name: 'Annual leave',
            paid: true,
            unit: 'day' as const,
            color: '#4c8bf5',
            icon: 'tree-palm',
            requiresDocumentAfterDays: null,
            countsWorkingDaysOnly: true,
            allowNegative: false,
            maxNegativeMinutes: 0,
            order: 0,
            archivedAt: null,
          },
        ],
      },
      balance: {
        get: async ({ personId }: { personId?: string }) => [
          {
            personId: personId ?? PEOPLE[0]!.id,
            leaveTypeId: '01920000-0000-7000-8000-00000000b001',
            leaveTypeName: 'Annual leave',
            unit: 'day' as const,
            periodYear: new Date().getFullYear(),
            balanceMinutes: 20 * 480,
            bookedMinutes: 0,
            pendingMinutes: 5 * 480,
            availableMinutes: 15 * 480,
            balance: 20,
            available: 15,
          },
        ],
      },
      requests: {
        list: async ({ workspaceId }: { workspaceId: string }) => ({
          items: leaveRequests.map((r) => ({ ...r, workspaceId })),
          nextCursor: null,
        }),
        simulate: async ({
          startsOn,
          endsOn,
        }: {
          workspaceId: string
          leaveTypeId: string
          startsOn: string
          endsOn: string
        }) => {
          const from = Date.parse(`${startsOn}T00:00:00Z`)
          const to = Date.parse(`${endsOn}T00:00:00Z`)
          const workingDays = Math.max(1, Math.round((to - from) / 86_400_000) + 1)
          const minutes = workingDays * 480
          return {
            workingDays,
            minutes,
            days: [],
            balanceBeforeMinutes: 20 * 480,
            balanceAfterMinutes: 20 * 480 - minutes,
            blockers: minutes > 20 * 480 ? [{ code: 'insufficient', message: 'Not enough balance' }] : [],
          }
        },
        create: async (input: {
          workspaceId: string
          leaveTypeId: string
          startsOn: string
          endsOn: string
          reason?: string | null
        }) => {
          const row = {
            id: crypto.randomUUID(),
            workspaceId: input.workspaceId,
            personId: PEOPLE[0]!.id,
            leaveTypeId: input.leaveTypeId,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            startPart: 'full',
            endPart: 'full',
            hours: null,
            workingDays: 1,
            minutes: 480,
            status: 'pending',
            reason: input.reason ?? null,
            documentFileId: null,
            approvalRequestId: null,
            decidedAt: null,
            createdAt: iso(),
            updatedAt: iso(),
          }
          leaveRequests.push(row)
          return row
        },
        cancel: async ({ requestId }: { workspaceId: string; requestId: string }) => {
          const row = leaveRequests.find((r) => r.id === requestId) ?? leaveRequests[0]!
          row.status = 'cancelled'
          return { ...row }
        },
      },
      team: {
        calendar: async () =>
          PEOPLE.filter((p) => p.status === 'on_leave').map((p) => ({
            personId: p.id,
            displayName: p.displayName,
            requestId: '01920000-0000-7000-8000-00000000c002',
            startsOn: day(-1),
            endsOn: day(3),
            status: 'approved' as const,
            leaveTypeName: 'Annual leave',
            color: '#4c8bf5',
          })),
      },
    },

    attendance: {
      state: async ({ workspaceId, personId }: { workspaceId: string; personId?: string }) => {
        void workspaceId
        return {
          personId: personId ?? PEOPLE[0]!.id,
          businessDate: day(0),
          clockedIn: clockedInAt !== null,
          onBreak,
          since: clockedInAt ? new Date(clockedInAt).toISOString() : null,
          workedMinutesToday: clockedInAt ? Math.round((Date.now() - clockedInAt) / 60_000) : 0,
          timezone: 'Europe/Istanbul',
        }
      },
      clockIn: async () => {
        clockedInAt = Date.now()
        return mockPunch('in')
      },
      clockOut: async () => {
        clockedInAt = null
        onBreak = false
        return mockPunch('out')
      },
      breakStart: async () => {
        onBreak = true
        return mockPunch('break_start')
      },
      breakEnd: async () => {
        onBreak = false
        return mockPunch('break_end')
      },
      days: {
        list: async ({ workspaceId }: { workspaceId: string }) => ({
          items: [0, 1, 2, 3, 4].map((n) => ({
            id: `01920000-0000-7000-8000-0000000a000${n}`,
            workspaceId,
            personId: PEOPLE[0]!.id,
            businessDate: day(-n),
            scheduledMinutes: 480,
            workedMinutes: n === 2 ? 0 : 480 + (n === 1 ? 45 : 0),
            breakMinutes: 60,
            overtimeMinutes: n === 1 ? 45 : 0,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
            status: n === 2 ? ('leave' as const) : ('present' as const),
            leaveRequestId: null,
            anomalies: [],
            firstIn: iso(n * 86_400_000),
            lastOut: iso(n * 86_400_000 - 8 * 3600_000),
            policyHash: null,
            locked: false,
            computedAt: iso(),
          })),
          nextCursor: null,
        }),
      },
    },

    approvals: {
      /**
       * Both tabs have something in them on purpose.
       *
       * A demo whose "Decided" tab is empty looks like a broken filter rather than an empty
       * history, and the two-step request is what shows the step counter at all.
       */
      inbox: async ({
        workspaceId,
        includeDecided = false,
      }: {
        workspaceId: string
        includeDecided?: boolean
      }) => ({
        items: approvalRequests
          .filter((r) => (includeDecided ? r.status !== 'pending' : r.status === 'pending'))
          .map((r) => ({ ...r, workspaceId })),
        nextCursor: null,
      }),

      get: async ({ workspaceId, requestId }: { workspaceId: string; requestId: string }) => {
        const found = approvalRequests.find((r) => r.id === requestId)
        if (!found) throw new Error('Approval request not found')
        return { ...found, workspaceId }
      },

      decide: async ({
        workspaceId,
        requestId,
        decision,
      }: {
        workspaceId: string
        requestId: string
        decision: 'approve' | 'reject'
      }) => {
        const found = approvalRequests.find((r) => r.id === requestId)
        if (!found) throw new Error('Approval request not found')
        // A middle step advances rather than settling: the inbox has to be able to show that.
        const last = found.currentStep >= Math.max(found.steps.length - 1, 0)
        if (decision === 'reject' || last) found.status = decision === 'approve' ? 'approved' : 'rejected'
        else found.currentStep += 1
        found.decidedAt = found.status === 'pending' ? null : iso()
        return { ...found, workspaceId }
      },

      delegations: async ({ workspaceId }: { workspaceId: string }) =>
        delegations.map((d) => ({ ...d, workspaceId })),

      delegate: async ({
        workspaceId,
        toPersonId,
        startsOn,
        endsOn,
        subjectType = null,
        reason = null,
      }: {
        workspaceId: string
        toPersonId: string
        startsOn: string
        endsOn: string
        subjectType?: string | null
        reason?: string | null
      }) => {
        const created = {
          id: crypto.randomUUID(),
          workspaceId,
          fromPersonId: PEOPLE[0]!.id,
          toPersonId,
          subjectType,
          startsOn,
          endsOn,
          reason,
          createdAt: iso(),
        }
        delegations.push(created)
        return created
      },

      revokeDelegation: async ({ delegationId }: { delegationId: string }) => {
        const at = delegations.findIndex((d) => d.id === delegationId)
        if (at >= 0) delegations.splice(at, 1)
        return { ok: true }
      },
    },
  }

  function mockPunch(direction: string) {
    return {
      id: crypto.randomUUID(),
      workspaceId: '',
      personId: PEOPLE[0]!.id,
      direction,
      at: new Date().toISOString(),
      clientReportedAt: null,
      skewMs: null,
      businessDate: day(0),
      timezone: 'Europe/Istanbul',
      method: 'web',
      officeId: OFFICES[0]!.id,
      deviceId: null,
      geo: null,
      trust: 'trusted',
      voidedByPunchId: null,
      note: null,
      createdAt: new Date().toISOString(),
    }
  }
}
