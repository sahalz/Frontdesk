import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getIstParts,
  makeUtcFromIst,
  snapToNextWorkingWindow,
  addWorkingMinutes,
  calculateSameWorkingDayDeadline,
  calculateElapsedWorkingMinutes,
  calculateInitialDeadlines,
  recalculateOnPriorityChange,
  isAutoCloseDue,
  isWithinReopenWindow
} from '../src/slaEngine.js';

test('SLA Engine - IST conversions', () => {
  // 2026-11-20 (Friday) 18:00 IST
  // In UTC: 18:00 - 5:30 = 12:30 UTC
  const utcDate = new Date(Date.UTC(2026, 10, 20, 12, 30, 0));
  const parts = getIstParts(utcDate);

  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 11);
  assert.equal(parts.day, 20);
  assert.equal(parts.dayOfWeek, 5); // Friday
  assert.equal(parts.hour, 18);
  assert.equal(parts.minute, 0);
  assert.equal(parts.minutesOfDay, 18 * 60);
});

test('SLA Engine - Friday 18:00 example from SRS section 3.2', () => {
  // A ticket arriving at 18:00 on Friday has 30 minutes elapsed by Monday 09:30 and is not late on Sunday
  const fri1800 = makeUtcFromIst(2026, 11, 20, 18 * 60, 0);
  const sun1200 = makeUtcFromIst(2026, 11, 22, 12 * 60, 0);
  const mon0930 = makeUtcFromIst(2026, 11, 23, 9 * 60 + 30, 0);

  // By Sunday 12:00, elapsed working time should be exactly 30 minutes
  const elapsedBySunday = calculateElapsedWorkingMinutes(fri1800, sun1200);
  assert.equal(elapsedBySunday, 30, 'Only 30 minutes elapsed by Sunday noon');

  // By Monday 09:30, elapsed working time should still be exactly 30 minutes
  const elapsedByMondayOpen = calculateElapsedWorkingMinutes(fri1800, mon0930);
  assert.equal(elapsedByMondayOpen, 30, 'Exactly 30 minutes elapsed by Monday 09:30');
});

test('SLA Engine - After-hours arrival snaps to next opening time', () => {
  // Friday 20:00 IST (after closing)
  const fri2000 = makeUtcFromIst(2026, 11, 20, 20 * 60, 0);
  const snapped = snapToNextWorkingWindow(fri2000);
  const snappedParts = getIstParts(snapped);

  assert.equal(snappedParts.dateStr, '2026-11-23', 'Snaps to Monday');
  assert.equal(snappedParts.hour, 9);
  assert.equal(snappedParts.minute, 30);
});

test('SLA Engine - Holiday exclusion', () => {
  // Monday 2026-11-23 is a holiday
  const holidays = ['2026-11-23'];
  const fri2000 = makeUtcFromIst(2026, 11, 20, 20 * 60, 0);
  const snapped = snapToNextWorkingWindow(fri2000, holidays);
  const snappedParts = getIstParts(snapped);

  assert.equal(snappedParts.dateStr, '2026-11-24', 'Snaps to Tuesday because Monday is a holiday');
  assert.equal(snappedParts.hour, 9);
  assert.equal(snappedParts.minute, 30);
});

test('SLA Engine - Urgent Priority: 2 working hours response and Same Working Day resolution', () => {
  // Arrives Monday 2026-11-23 at 10:00 IST
  const mon1000 = makeUtcFromIst(2026, 11, 23, 10 * 60, 0);
  const { responseDeadline, resolutionDeadline } = calculateInitialDeadlines(mon1000, 'urgent');

  // Response: 2 working hours -> 12:00 IST Monday
  const respParts = getIstParts(responseDeadline);
  assert.equal(respParts.dateStr, '2026-11-23');
  assert.equal(respParts.hour, 12);
  assert.equal(respParts.minute, 0);

  // Resolution: Same working day -> 18:30 IST Monday
  const resParts = getIstParts(resolutionDeadline);
  assert.equal(resParts.dateStr, '2026-11-23');
  assert.equal(resParts.hour, 18);
  assert.equal(resParts.minute, 30);
});

test('SLA Engine - Urgent Priority: Created after hours resolves by next working day 18:30', () => {
  // Arrives Monday 2026-11-23 at 19:00 IST
  const mon1900 = makeUtcFromIst(2026, 11, 23, 19 * 60, 0);
  const { responseDeadline, resolutionDeadline } = calculateInitialDeadlines(mon1900, 'urgent');

  // Response: starts Tue 09:30 + 2h -> Tue 11:30 IST
  const respParts = getIstParts(responseDeadline);
  assert.equal(respParts.dateStr, '2026-11-24');
  assert.equal(respParts.hour, 11);
  assert.equal(respParts.minute, 30);

  // Resolution: next working day 18:30 IST
  const resParts = getIstParts(resolutionDeadline);
  assert.equal(resParts.dateStr, '2026-11-24');
  assert.equal(resParts.hour, 18);
  assert.equal(resParts.minute, 30);
});

test('SLA Engine - Medium Priority: 4.5h response & 3 working days resolution spanning a weekend', () => {
  // Arrives Friday 2026-11-20 at 16:00 IST
  // Remaining on Friday: 2.5 hours (16:00 to 18:30)
  // Needed for first reply: 4.5 hours -> remaining 2 hours carried into Monday -> Monday 11:30 IST
  const fri1600 = makeUtcFromIst(2026, 11, 20, 16 * 60, 0);
  const { responseDeadline, resolutionDeadline } = calculateInitialDeadlines(fri1600, 'medium');

  const respParts = getIstParts(responseDeadline);
  assert.equal(respParts.dateStr, '2026-11-23');
  assert.equal(respParts.hour, 11);
  assert.equal(respParts.minute, 30);

  // Resolution: 3 working days (27 working hours)
  // Fri: 2.5h (rem 24.5h)
  // Mon: 9h (rem 15.5h)
  // Tue: 9h (rem 6.5h)
  // Wed: 6.5h from 09:30 -> 16:00 IST
  const resParts = getIstParts(resolutionDeadline);
  assert.equal(resParts.dateStr, '2026-11-25');
  assert.equal(resParts.hour, 16);
  assert.equal(resParts.minute, 0);
});

test('SLA Engine - Priority Change & Non-removal of breaches', () => {
  const mon1000 = makeUtcFromIst(2026, 11, 23, 10 * 60, 0);
  // Suppose it was urgent, breached response SLA
  const now = makeUtcFromIst(2026, 11, 23, 14 * 60, 0); // 4 hours later (response deadline was 12:00)

  const recomputed = recalculateOnPriorityChange({
    createdAt: mon1000,
    newPriority: 'low', // Downgrading to low
    totalPausedMinutes: 0,
    currentTime: now,
    currentResponseBreached: true // was already breached!
  });

  // A downgrade never removes an existing breach (FR-4, Section 3.6)
  assert.equal(recomputed.responseBreached, true, 'Downgrade must never remove existing breach');
});

test('SLA Engine - Priority Upgrade causing immediate breach', () => {
  const mon1000 = makeUtcFromIst(2026, 11, 23, 10 * 60, 0);
  // Created at 10:00 as Low (1 day response = Tuesday 10:00)
  // At 13:00, upgraded to Urgent (Urgent response deadline is 12:00, which has passed!)
  const mon1300 = makeUtcFromIst(2026, 11, 23, 13 * 60, 0);

  const recomputed = recalculateOnPriorityChange({
    createdAt: mon1000,
    newPriority: 'urgent',
    totalPausedMinutes: 0,
    currentTime: mon1300,
    currentResponseBreached: false
  });

  assert.equal(recomputed.responseBreached, true, 'Upgraded deadline in past causes immediate breach');
});

test('SLA Engine - Auto-Close (5 working days in Waiting on customer)', () => {
  const waitingSince = makeUtcFromIst(2026, 11, 16, 10 * 60, 0); // Mon 10:00
  // Mon 10:00 to Fri 18:30 is 44.5 hours (< 45 working hours)
  const fri1830 = makeUtcFromIst(2026, 11, 20, 18 * 60 + 30, 0);
  // Next Monday 10:00 is exactly 45 working hours (5 full working days)
  const nextMon1000 = makeUtcFromIst(2026, 11, 23, 10 * 60, 0);

  assert.equal(isAutoCloseDue(waitingSince, fri1830), false, 'Not due yet on Friday before 45 working hours');
  assert.equal(isAutoCloseDue(waitingSince, nextMon1000), true, 'Due on next Monday after 45 working hours (5 working days)');
});

test('SLA Engine - Reopen Window (5 working days)', () => {
  const resolvedAt = makeUtcFromIst(2026, 11, 16, 10 * 60, 0);
  const withinWindow = makeUtcFromIst(2026, 11, 20, 10 * 60, 0);
  const outsideWindow = makeUtcFromIst(2026, 11, 23, 11 * 60, 0); // Next Monday

  assert.equal(isWithinReopenWindow(resolvedAt, withinWindow), true);
  assert.equal(isWithinReopenWindow(resolvedAt, outsideWindow), false);
});

test('SLA Engine - Reopening a resolved ticket extends resolution deadline by time spent in Resolved', () => {
  // Ticket created on Monday 10:00 as Medium priority (3 working days = Thursday 10:00 resolution deadline)
  const mon1000 = makeUtcFromIst(2026, 11, 16, 10 * 60, 0);
  const { resolutionDeadline } = calculateInitialDeadlines(mon1000, 'medium');

  // Resolved early on Tuesday 12:00 (spent 11 hours working time, 16 hours left of the 27-hour SLA)
  const tue1200 = makeUtcFromIst(2026, 11, 17, 12 * 60, 0);

  // Sits resolved for 3 full working days until Friday 12:00
  const fri1200 = makeUtcFromIst(2026, 11, 20, 12 * 60, 0);

  // Elapsed working time while sitting in Resolved
  const pausedWorkingMins = calculateElapsedWorkingMinutes(tue1200, fri1200);
  assert.equal(pausedWorkingMins, 3 * 540, 'Should have paused for 3 working days (1620 mins)');

  // Reopen extends resolution deadline by the 1620 minutes
  const extendedDeadline = addWorkingMinutes(resolutionDeadline, pausedWorkingMins);

  // Original deadline was Thursday 10:00; extended deadline must be 3 working days later (next Tuesday 10:00)
  const extParts = getIstParts(extendedDeadline);
  assert.equal(extParts.dateStr, '2026-11-24', 'Extended to next Tuesday');
  assert.equal(extParts.hour, 10);
  assert.equal(extParts.minute, 0);

  // And at Friday 12:00 (reopen time), the extended deadline (Tue 10:00) has NOT passed
  assert.ok(fri1200 < extendedDeadline, 'Reopened ticket must not be instantly late when resolved time is excluded');
});
