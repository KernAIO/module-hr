/**
 * Whether the personnel fields on a card were withheld, or are genuinely empty.
 *
 * `HrAccessService` nulls four of them — personal email, phone, hire date, termination date — for
 * anybody outside the reader's record scope, and nulls them **in place**: a redacted card parses as
 * an ordinary `Person`, so a blank phone number would otherwise arrive at a screen meaning either
 * "we are not showing you this" or "this person never gave us one". Those are two different facts
 * about a colleague, and printing the second when the first is true is the defect this exists to
 * stop.
 *
 * **The record says which, and this only reads it.** `Person.personnelHidden` is set in `forViewer`,
 * the single place that does the nulling — so the answer comes from the code that made the decision
 * rather than from a client re-deriving it.
 *
 * That matters because the client cannot re-derive it. This helper used to infer the answer from
 * the reader's own permission keys, which works for the two extremes — somebody holding
 * `hr.person.view_all` or `hr.person.manage` has nothing hidden, somebody holding none of the
 * widening keys has everything but their own record hidden — and fails in the middle. A line
 * manager or a country HR person holds `view_team` or `view_office`, and **which** people those
 * cover is resolved on the server from the org chart: headship of a unit over an ltree subtree,
 * headship of an office, `manager_person_id`, all as of today, across rows the directory never
 * fetches. Inferring it would have meant a second implementation of that resolution, and "all four
 * fields are null" is not evidence — a person really can have no personal email, no phone and no
 * recorded hire date.
 */
export interface PersonnelSubject {
  /**
   * True when the server withheld the personnel fields on this record.
   *
   * Optional so a caller can pass a row that predates the field — `dev:mock` fixtures, an older
   * cached payload — and get `false` rather than a crash. Absent means "not withheld", which is the
   * safe direction: a screen that fails to mark a hidden field shows a blank, while one that marks
   * an empty field asserts something false about a colleague.
   */
  personnelHidden?: boolean
}

/** Were this card's personnel fields withheld from the reader? */
export const personnelWithheld = (person: PersonnelSubject): boolean => person.personnelHidden === true
