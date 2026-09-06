/**
 * Demo content for HR.
 *
 * A staffed company: departments, positions, twelve people with employments and managers, leave
 * types with real balances, leave that has been taken and leave that is waiting for a decision, a
 * working-hours schedule and a week of attendance.
 *
 * The person rows carry no `userId` — nobody here has an account, which is the ordinary case for HR
 * and the only honest one for demo content: inventing accounts would put strangers in the workspace
 * member list and in everybody's mention picker. The one exception is the person created for
 * whoever asked for the demo, so the directory has a face they recognise and "my leave" is theirs.
 *
 * Written through the module's own services wherever one exists — `PeopleService.changeEmployment`,
 * `LedgerService.append`, `AttendanceService.record`/`recomputeDay` — because those are what keep
 * the derived rows (employment history, balance cursors, attendance days) in step with the raw ones.
 */
import { type DemoSeedContext, type DemoSeedSummary, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, eq } from 'drizzle-orm'
import {
  leaveRequestDays,
  leaveRequests,
  leaveTypes,
  offices,
  orgUnits,
  people,
  positions,
  scheduleAssignments,
  schedules,
} from './schema.js'
import { AttendanceService } from './services/attendance.js'
import { LedgerService } from './services/ledger.js'
import { PeopleService } from './services/people.js'
import { PolicyService } from './services/policies.js'
import { ResolveService } from './services/resolve.js'

const DAY = 86_400_000
const MINUTES_PER_DAY = 480

const at = (now: Date, days: number): Date => new Date(now.getTime() + days * DAY)
const iso = (d: Date): string => d.toISOString().slice(0, 10)

interface DeptSeed {
  code: string
  name: string
  segment: string
}

const DEPARTMENTS: DeptSeed[] = [
  { code: 'ENG', name: 'Engineering', segment: 'eng' },
  { code: 'PRD', name: 'Product', segment: 'prd' },
  { code: 'GRW', name: 'Growth', segment: 'grw' },
  { code: 'SUP', name: 'Customer support', segment: 'sup' },
  { code: 'OPS', name: 'Operations', segment: 'ops' },
]

const POSITIONS: Array<{ title: string; family: string; level: string }> = [
  { title: 'Head of Engineering', family: 'Engineering', level: 'Lead' },
  { title: 'Senior Engineer', family: 'Engineering', level: 'Senior' },
  { title: 'Engineer', family: 'Engineering', level: 'Mid' },
  { title: 'Product Manager', family: 'Product', level: 'Senior' },
  { title: 'Designer', family: 'Product', level: 'Mid' },
  { title: 'Content Lead', family: 'Growth', level: 'Senior' },
  { title: 'Support Specialist', family: 'Support', level: 'Mid' },
  { title: 'Office Manager', family: 'Operations', level: 'Mid' },
]

interface PersonSeed {
  name: string
  email: string
  dept: string
  position: string
  /** whole months before today */
  hiredMonthsAgo: number
  managerOf?: string
  reportsTo?: string
  type?: 'full_time' | 'part_time' | 'contractor'
}

const PEOPLE: PersonSeed[] = [
  {
    name: 'Amara Osei',
    email: 'amara.osei@example.com',
    dept: 'ENG',
    position: 'Head of Engineering',
    hiredMonthsAgo: 41,
    managerOf: 'ENG',
  },
  {
    name: 'Bruno Kessler',
    email: 'bruno.kessler@example.com',
    dept: 'ENG',
    position: 'Senior Engineer',
    hiredMonthsAgo: 28,
    reportsTo: 'Amara Osei',
  },
  {
    name: 'Chen Wei',
    email: 'chen.wei@example.com',
    dept: 'ENG',
    position: 'Senior Engineer',
    hiredMonthsAgo: 22,
    reportsTo: 'Amara Osei',
  },
  {
    name: 'Dilara Yılmaz',
    email: 'dilara.yilmaz@example.com',
    dept: 'ENG',
    position: 'Engineer',
    hiredMonthsAgo: 9,
    reportsTo: 'Amara Osei',
  },
  {
    name: 'Elena Rossi',
    email: 'elena.rossi@example.com',
    dept: 'PRD',
    position: 'Product Manager',
    hiredMonthsAgo: 33,
    managerOf: 'PRD',
  },
  {
    name: 'Farid Haddad',
    email: 'farid.haddad@example.com',
    dept: 'PRD',
    position: 'Designer',
    hiredMonthsAgo: 15,
    reportsTo: 'Elena Rossi',
  },
  {
    name: 'Greta Lindqvist',
    email: 'greta.lindqvist@example.com',
    dept: 'GRW',
    position: 'Content Lead',
    hiredMonthsAgo: 19,
    managerOf: 'GRW',
  },
  {
    name: 'Hugo Ferreira',
    email: 'hugo.ferreira@example.com',
    dept: 'GRW',
    position: 'Content Lead',
    hiredMonthsAgo: 6,
    reportsTo: 'Greta Lindqvist',
    type: 'part_time',
  },
  {
    name: 'Ingrid Sørensen',
    email: 'ingrid.sorensen@example.com',
    dept: 'SUP',
    position: 'Support Specialist',
    hiredMonthsAgo: 25,
    managerOf: 'SUP',
  },
  {
    name: 'Jonas Meyer',
    email: 'jonas.meyer@example.com',
    dept: 'SUP',
    position: 'Support Specialist',
    hiredMonthsAgo: 11,
    reportsTo: 'Ingrid Sørensen',
  },
  {
    name: 'Kaori Tanaka',
    email: 'kaori.tanaka@example.com',
    dept: 'OPS',
    position: 'Office Manager',
    hiredMonthsAgo: 37,
    managerOf: 'OPS',
  },
  {
    name: 'Liam Byrne',
    email: 'liam.byrne@example.com',
    dept: 'OPS',
    position: 'Office Manager',
    hiredMonthsAgo: 4,
    reportsTo: 'Kaori Tanaka',
    type: 'contractor',
  },
]

const LEAVE_TYPES = [
  { key: 'annual', name: 'Annual leave', color: '#3aa17e', icon: 'palmtree', paid: true, order: 0 },
  { key: 'sick', name: 'Sick leave', color: '#d64545', icon: 'thermometer', paid: true, order: 1 },
  { key: 'parental', name: 'Parental leave', color: '#8a6fd1', icon: 'baby', paid: true, order: 2 },
  { key: 'unpaid', name: 'Unpaid leave', color: '#8b8578', icon: 'circle-minus', paid: false, order: 3 },
]

/** Leave to book, as offsets in days from today. */
const LEAVE: Array<{
  who: string
  type: string
  from: number
  to: number
  status: 'approved' | 'pending' | 'rejected'
  reason: string
}> = [
  { who: 'Bruno Kessler', type: 'annual', from: -31, to: -25, status: 'approved', reason: 'Family visit' },
  { who: 'Elena Rossi', type: 'annual', from: -12, to: -8, status: 'approved', reason: 'Half-term' },
  { who: 'Jonas Meyer', type: 'sick', from: -5, to: -4, status: 'approved', reason: 'Flu' },
  { who: 'Chen Wei', type: 'annual', from: 7, to: 18, status: 'approved', reason: 'Booked in January' },
  { who: 'Dilara Yılmaz', type: 'annual', from: 12, to: 16, status: 'pending', reason: 'Wedding' },
  { who: 'Farid Haddad', type: 'annual', from: 26, to: 33, status: 'pending', reason: 'Summer' },
  { who: 'Hugo Ferreira', type: 'unpaid', from: 40, to: 47, status: 'pending', reason: 'Sabbatical week' },
]

export async function seedHrDemo(ctx: DemoSeedContext): Promise<DemoSeedSummary> {
  const { kernel, workspaceId, actorId, now } = ctx
  const svc = new PeopleService(kernel)
  const ledger = new LedgerService()
  const resolve = new ResolveService()
  const attendance = new AttendanceService(resolve, new PolicyService(resolve))
  const year = now.getUTCFullYear()

  return kernel.database.withWorkspace(
    workspaceId,
    async (tx) => {
      // See the tracker's seeder for why the guard reads the table rather than a marker row.
      const [existing] = await tx.select({ id: people.id }).from(people).limit(1)
      if (existing) return { skipped: true }

      const [office] = await tx
        .select({ id: offices.id, timezone: offices.timezone })
        .from(offices)
        .where(eq(offices.workspaceId, workspaceId))
        .limit(1)
      const timezone = office?.timezone ?? 'UTC'

      const deptIds = new Map<string, string>()
      for (const d of DEPARTMENTS) {
        const [row] = await tx
          .insert(orgUnits)
          .values({
            id: uuidv7(),
            workspaceId,
            parentId: null,
            // `path` is an ltree, so a segment may hold letters, digits and underscores only.
            path: d.segment,
            name: d.name,
            code: d.code,
          })
          .returning()
        deptIds.set(d.code, row!.id)
      }

      const positionIds = new Map<string, string>()
      for (const p of POSITIONS) {
        const [row] = await tx
          .insert(positions)
          .values({
            id: uuidv7(),
            workspaceId,
            title: p.title,
            jobFamily: p.family,
            level: p.level,
          })
          .returning()
        positionIds.set(p.title, row!.id)
      }

      const leaveTypeIds = new Map<string, string>()
      for (const t of LEAVE_TYPES) {
        const [row] = await tx
          .insert(leaveTypes)
          .values({ id: uuidv7(), workspaceId, ...t })
          .returning()
        leaveTypeIds.set(t.key, row!.id)
      }

      /*
       * The people, in two passes: everybody exists before anybody points at a manager. One pass
       * would need the seeds ordered so that a manager is always written before their reports,
       * which is a constraint on the data rather than on the code and would break the first time
       * somebody adds a name in the middle.
       */
      const personIds = new Map<string, string>()
      const owner = await insertPerson(tx, workspaceId, {
        displayName: 'You',
        workEmail: null,
        userId: actorId,
        hiredOn: iso(at(now, -365)),
      })
      personIds.set('You', owner)

      for (const seed of PEOPLE) {
        const hiredOn = new Date(Date.UTC(year, now.getUTCMonth() - seed.hiredMonthsAgo, 12))
        personIds.set(
          seed.name,
          await insertPerson(tx, workspaceId, {
            displayName: seed.name,
            workEmail: seed.email,
            userId: null,
            hiredOn: iso(hiredOn),
          }),
        )
      }

      for (const seed of PEOPLE) {
        const personId = personIds.get(seed.name)!
        const hiredOn = new Date(Date.UTC(year, now.getUTCMonth() - seed.hiredMonthsAgo, 12))
        await svc.changeEmployment(tx, workspaceId, personId, iso(hiredOn), {
          orgUnitId: deptIds.get(seed.dept) ?? null,
          positionId: positionIds.get(seed.position) ?? null,
          managerPersonId: seed.reportsTo ? (personIds.get(seed.reportsTo) ?? null) : null,
          employmentType: seed.type ?? 'full_time',
        })
        if (office)
          await svc.assignOffice(tx, workspaceId, personId, office.id, true, iso(hiredOn), 'created')
      }
      await svc.changeEmployment(tx, workspaceId, owner, iso(at(now, -365)), {
        orgUnitId: deptIds.get('OPS') ?? null,
        positionId: null,
        managerPersonId: null,
        employmentType: 'full_time',
      })
      if (office)
        await svc.assignOffice(tx, workspaceId, owner, office.id, true, iso(at(now, -365)), 'created')

      // Department heads, now that the people they head exist.
      for (const seed of PEOPLE.filter((p) => p.managerOf))
        await tx
          .update(orgUnits)
          .set({ headPersonId: personIds.get(seed.name)! })
          .where(and(eq(orgUnits.workspaceId, workspaceId), eq(orgUnits.id, deptIds.get(seed.managerOf!)!)))

      /*
       * This year's entitlement, as one accrual per person. A balance is the sum of the ledger and
       * nothing else, so a demo that wrote a number onto a person would show the right figure and
       * an empty history behind it — and the history is the screen the module exists for.
       */
      const annual = leaveTypeIds.get('annual')!
      for (const personId of personIds.values())
        await ledger.append(tx, workspaceId, {
          personId,
          leaveTypeId: annual,
          kind: 'accrual',
          amountMinutes: 25 * MINUTES_PER_DAY,
          effectiveOn: `${year}-01-01`,
          periodYear: year,
          reason: 'Annual entitlement',
          createdBy: actorId,
        })

      let leaveCount = 0
      for (const l of LEAVE) {
        const personId = personIds.get(l.who)
        const leaveTypeId = leaveTypeIds.get(l.type)
        if (!personId || !leaveTypeId) continue
        await bookLeave(tx, ledger, {
          workspaceId,
          actorId,
          personId,
          leaveTypeId,
          startsOn: iso(at(now, l.from)),
          endsOn: iso(at(now, l.to)),
          status: l.status,
          reason: l.reason,
          year,
        })
        leaveCount += 1
      }

      /*
       * One schedule, assigned to everybody, and a week of punches for three people. Three is
       * enough for the attendance screens to have something to draw and few enough that the demo
       * does not claim a company where everybody clocks in — which most of these roles would not.
       */
      const [schedule] = await tx
        .insert(schedules)
        .values({
          id: uuidv7(),
          workspaceId,
          name: 'Standard week',
          kind: 'fixed',
          week: {
            mon: { start: '09:00', end: '17:30', breakMinutes: 30 },
            tue: { start: '09:00', end: '17:30', breakMinutes: 30 },
            wed: { start: '09:00', end: '17:30', breakMinutes: 30 },
            thu: { start: '09:00', end: '17:30', breakMinutes: 30 },
            fri: { start: '09:00', end: '16:00', breakMinutes: 30 },
            sat: null,
            sun: null,
          },
          tzMode: 'office',
          graceInMinutes: 10,
          graceOutMinutes: 10,
          roundingStepMinutes: 5,
          roundingDirection: 'nearest',
          autoClockOutAfterMinutes: 16 * 60,
        })
        .returning()

      for (const personId of personIds.values())
        await tx.insert(scheduleAssignments).values({
          id: uuidv7(),
          workspaceId,
          personId,
          scheduleId: schedule!.id,
          effectiveFrom: iso(at(now, -400)),
        })

      let punches = 0
      for (const name of ['Ingrid Sørensen', 'Jonas Meyer', 'Kaori Tanaka']) {
        const personId = personIds.get(name)
        if (!personId) continue
        punches += await punchWeek(tx, attendance, { workspaceId, personId, timezone, now })
      }

      return {
        created: {
          departments: DEPARTMENTS.length,
          positions: POSITIONS.length,
          people: personIds.size,
          leaveRequests: leaveCount,
          punches,
        },
      }
    },
    { userId: actorId },
  )
}

async function insertPerson(
  tx: Tx,
  workspaceId: string,
  input: { displayName: string; workEmail: string | null; userId: string | null; hiredOn: string },
): Promise<string> {
  const [row] = await tx
    .insert(people)
    .values({
      id: uuidv7(),
      workspaceId,
      userId: input.userId,
      displayName: input.displayName,
      workEmail: input.workEmail,
      hiredOn: input.hiredOn,
      status: 'active',
    })
    .returning()
  return row!.id
}

/**
 * A leave request, its days, and the ledger entry that pays for it.
 *
 * Weekends are written as uncounted days rather than skipped: they are part of the range somebody
 * asked for, they cost nothing, and the partial unique index that stops double-booking is built on
 * counted days only — so writing them is both truthful and free.
 */
async function bookLeave(
  tx: Tx,
  ledger: LedgerService,
  input: {
    workspaceId: string
    actorId: string
    personId: string
    leaveTypeId: string
    startsOn: string
    endsOn: string
    status: 'approved' | 'pending' | 'rejected'
    reason: string
    year: number
  },
): Promise<void> {
  const requestId = uuidv7()
  const days: Array<{ date: string; counted: boolean }> = []
  for (
    let d = new Date(`${input.startsOn}T00:00:00Z`);
    d <= new Date(`${input.endsOn}T00:00:00Z`);
    d = new Date(d.getTime() + DAY)
  ) {
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6
    days.push({ date: iso(d), counted: !weekend })
  }
  const counted = days.filter((d) => d.counted).length
  const minutes = counted * MINUTES_PER_DAY

  await tx.insert(leaveRequests).values({
    id: requestId,
    workspaceId: input.workspaceId,
    personId: input.personId,
    leaveTypeId: input.leaveTypeId,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    workingDays: String(counted),
    minutes,
    status: input.status,
    reason: input.reason,
    decidedAt: input.status === 'pending' ? null : new Date(),
  })
  await tx.insert(leaveRequestDays).values(
    days.map((d) => ({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      requestId,
      personId: input.personId,
      date: d.date,
      counted: d.counted,
      status: input.status,
    })),
  )
  // Only approved leave is spent. A pending request holds no balance until somebody decides it,
  // which is the whole reason the balance and the request are different things.
  if (input.status === 'approved')
    await ledger.append(tx, input.workspaceId, {
      personId: input.personId,
      leaveTypeId: input.leaveTypeId,
      kind: 'consumption',
      amountMinutes: -minutes,
      effectiveOn: input.startsOn,
      periodYear: input.year,
      requestId,
      reason: input.reason,
      createdBy: input.actorId,
    })
}

/** Clock in and out across the five working days before today. */
async function punchWeek(
  tx: Tx,
  attendance: AttendanceService,
  input: { workspaceId: string; personId: string; timezone: string; now: Date },
): Promise<number> {
  const { workspaceId, personId, timezone, now } = input
  const schedule = await attendance.scheduleFor(tx, workspaceId, personId, iso(now))
  let written = 0
  // Friday backwards: five weekdays, none of them today, so nothing is half-open.
  const dates: string[] = []
  let cursor = now
  while (dates.length < 5) {
    cursor = new Date(cursor.getTime() - DAY)
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.push(iso(cursor))
  }

  for (const businessDate of dates) {
    // A few minutes either side of the shift, so the day is not suspiciously exact.
    const jitter = (dates.indexOf(businessDate) * 7) % 13
    const inAt = new Date(`${businessDate}T08:${String(52 + (jitter % 8)).padStart(2, '0')}:00Z`)
    const outAt = new Date(`${businessDate}T17:${String(28 + (jitter % 9)).padStart(2, '0')}:00Z`)
    for (const [direction, at_] of [
      ['in', inAt],
      ['out', outAt],
    ] as Array<['in' | 'out', Date]>) {
      await attendance.record(tx, workspaceId, {
        personId,
        direction,
        at: at_,
        businessDate,
        timezone,
        method: 'web',
      })
      written += 1
    }
    await attendance.recomputeDay(tx, workspaceId, personId, businessDate, timezone, schedule)
  }
  return written
}
