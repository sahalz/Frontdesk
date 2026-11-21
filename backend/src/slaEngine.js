/**
 * SLA & Working Calendar Calculation Engine for Frontdesk
 * Arvo Systems SRS v1.0
 *
 * Working hours: 09:30 to 18:30 IST, Monday to Friday (9 hours / 540 min per day)
 * IST Timezone: UTC+05:30 (+330 minutes)
 */

export const IST_OFFSET_MINUTES = 330; // UTC+5:30
export const WORK_START_HOUR = 9;
export const WORK_START_MINUTE = 30;
export const WORK_START_MINUTES_OF_DAY = WORK_START_HOUR * 60 + WORK_START_MINUTE; // 570 min

export const WORK_END_HOUR = 18;
export const WORK_END_MINUTE = 30;
export const WORK_END_MINUTES_OF_DAY = WORK_END_HOUR * 60 + WORK_END_MINUTE; // 1110 min

export const WORK_MINUTES_PER_DAY = WORK_END_MINUTES_OF_DAY - WORK_START_MINUTES_OF_DAY; // 540 min (9 hours)

export const DEFAULT_SLA_CONFIG = {
  urgent: {
    first_reply_minutes: 120, // 2 working hours
    resolve_type: 'same_working_day',
    resolve_minutes: 0 // handled by same working day logic
  },
  medium: {
    first_reply_minutes: 270, // 4.5 working hours (half day)
    resolve_type: 'working_minutes',
    resolve_minutes: 3 * WORK_MINUTES_PER_DAY // 3 working days = 1620 min
  },
  low: {
    first_reply_minutes: WORK_MINUTES_PER_DAY, // 1 working day = 540 min
    resolve_type: 'working_minutes',
    resolve_minutes: 5 * WORK_MINUTES_PER_DAY // 5 working days = 2700 min
  }
};

/**
 * Converts a UTC Date into IST parts: { year, month, day, dayOfWeek, hour, minute, second, dateStr, minutesOfDay }
 */
export function getIstParts(date) {
  const utcMs = date.getTime();
  const istMs = utcMs + IST_OFFSET_MINUTES * 60 * 1000;
  const istDate = new Date(istMs);

  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth() + 1; // 1-12
  const day = istDate.getUTCDate();
  const dayOfWeek = istDate.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const hour = istDate.getUTCHours();
  const minute = istDate.getUTCMinutes();
  const second = istDate.getUTCSeconds();

  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${year}-${pad(month)}-${pad(day)}`;
  const minutesOfDay = hour * 60 + minute;

  return { year, month, day, dayOfWeek, hour, minute, second, dateStr, minutesOfDay };
}

/**
 * Creates a UTC Date from IST date string and minutes of day.
 */
export function makeUtcFromIst(year, month, day, minutesOfDay, seconds = 0) {
  const hour = Math.floor(minutesOfDay / 60);
  const min = minutesOfDay % 60;
  // Construct UTC timestamp corresponding to IST wall-clock
  const istMs = Date.UTC(year, month - 1, day, hour, min, seconds);
  return new Date(istMs - IST_OFFSET_MINUTES * 60 * 1000);
}

/**
 * Checks whether an IST calendar date is a working day (Mon-Fri and not in holiday list).
 */
export function isWorkingDay(dayOfWeek, dateStr, holidays = []) {
  if (dayOfWeek === 0 || dayOfWeek === 6) return false; // Sunday or Saturday
  if (holidays.includes(dateStr)) return false;
  return true;
}

/**
 * If the given time is outside working hours, snaps it forward to the start of the next working window (09:30 IST).
 * If already inside working hours, returns the same time.
 */
export function snapToNextWorkingWindow(date, holidays = []) {
  let parts = getIstParts(date);

  // If on a working day
  if (isWorkingDay(parts.dayOfWeek, parts.dateStr, holidays)) {
    if (parts.minutesOfDay < WORK_START_MINUTES_OF_DAY) {
      return makeUtcFromIst(parts.year, parts.month, parts.day, WORK_START_MINUTES_OF_DAY, 0);
    }
    if (parts.minutesOfDay < WORK_END_MINUTES_OF_DAY) {
      return date;
    }
  }

  // Otherwise, advance day by day until a working day is found and set to 09:30 IST
  let curUtcMs = date.getTime();
  while (true) {
    // Advance to next calendar day in IST at 09:30
    const istMs = curUtcMs + IST_OFFSET_MINUTES * 60 * 1000;
    const curIst = new Date(istMs);
    curIst.setUTCDate(curIst.getUTCDate() + 1);
    const nextYear = curIst.getUTCFullYear();
    const nextMonth = curIst.getUTCMonth() + 1;
    const nextDay = curIst.getUTCDate();
    const nextDow = curIst.getUTCDay();
    const pad = (n) => String(n).padStart(2, '0');
    const nextDateStr = `${nextYear}-${pad(nextMonth)}-${pad(nextDay)}`;

    if (isWorkingDay(nextDow, nextDateStr, holidays)) {
      return makeUtcFromIst(nextYear, nextMonth, nextDay, WORK_START_MINUTES_OF_DAY, 0);
    }
    curUtcMs = curIst.getTime() - IST_OFFSET_MINUTES * 60 * 1000;
  }
}

/**
 * Adds N working minutes to a start time, obeying working hours and holidays.
 */
export function addWorkingMinutes(startDate, minutesToAdd, holidays = []) {
  if (minutesToAdd <= 0) return startDate;

  let current = snapToNextWorkingWindow(startDate, holidays);
  let remainingMinutes = minutesToAdd;

  while (remainingMinutes > 0) {
    const parts = getIstParts(current);
    const minutesLeftToday = WORK_END_MINUTES_OF_DAY - parts.minutesOfDay;

    if (remainingMinutes <= minutesLeftToday) {
      return makeUtcFromIst(parts.year, parts.month, parts.day, parts.minutesOfDay + remainingMinutes, parts.second);
    }

    remainingMinutes -= minutesLeftToday;
    // Advance to next working day opening at 09:30
    const endOfDayUtc = makeUtcFromIst(parts.year, parts.month, parts.day, WORK_END_MINUTES_OF_DAY, 0);
    current = snapToNextWorkingWindow(new Date(endOfDayUtc.getTime() + 60 * 1000), holidays);
  }

  return current;
}

/**
 * Calculates "Same Working Day" resolution deadline:
 * 18:30 IST of current day if created during working hours.
 * 18:30 IST of next working day if created after hours or on weekend/holiday.
 */
export function calculateSameWorkingDayDeadline(startDate, holidays = []) {
  const parts = getIstParts(startDate);
  const isWorking = isWorkingDay(parts.dayOfWeek, parts.dateStr, holidays);

  if (isWorking && parts.minutesOfDay >= WORK_START_MINUTES_OF_DAY && parts.minutesOfDay < WORK_END_MINUTES_OF_DAY) {
    return makeUtcFromIst(parts.year, parts.month, parts.day, WORK_END_MINUTES_OF_DAY, 0);
  }

  // Arrived before opening on a working day
  if (isWorking && parts.minutesOfDay < WORK_START_MINUTES_OF_DAY) {
    return makeUtcFromIst(parts.year, parts.month, parts.day, WORK_END_MINUTES_OF_DAY, 0);
  }

  // Arrived after hours or on a non-working day -> next working day 18:30 IST
  const nextOpen = snapToNextWorkingWindow(startDate, holidays);
  const nextParts = getIstParts(nextOpen);
  return makeUtcFromIst(nextParts.year, nextParts.month, nextParts.day, WORK_END_MINUTES_OF_DAY, 0);
}

/**
 * Calculates working minutes elapsed between two timestamps, excluding non-working hours and holidays.
 */
export function calculateElapsedWorkingMinutes(startDate, endDate, holidays = []) {
  if (endDate <= startDate) return 0;

  let current = new Date(startDate.getTime());
  let totalMinutes = 0;

  while (current < endDate) {
    const parts = getIstParts(current);

    if (!isWorkingDay(parts.dayOfWeek, parts.dateStr, holidays)) {
      // Fast-forward to next working day start
      const nextDayMs = makeUtcFromIst(parts.year, parts.month, parts.day + 1, WORK_START_MINUTES_OF_DAY, 0).getTime();
      current = new Date(Math.min(nextDayMs, endDate.getTime()));
      continue;
    }

    if (parts.minutesOfDay < WORK_START_MINUTES_OF_DAY) {
      // Before working hours today, jump to 09:30
      const openToday = makeUtcFromIst(parts.year, parts.month, parts.day, WORK_START_MINUTES_OF_DAY, 0);
      current = new Date(Math.min(openToday.getTime(), endDate.getTime()));
      continue;
    }

    if (parts.minutesOfDay >= WORK_END_MINUTES_OF_DAY) {
      // After working hours today, jump to tomorrow 09:30
      const openTomorrow = makeUtcFromIst(parts.year, parts.month, parts.day + 1, WORK_START_MINUTES_OF_DAY, 0);
      current = new Date(Math.min(openTomorrow.getTime(), endDate.getTime()));
      continue;
    }

    // Currently inside working hours today
    const dayEnd = makeUtcFromIst(parts.year, parts.month, parts.day, WORK_END_MINUTES_OF_DAY, 0);
    const windowEnd = endDate < dayEnd ? endDate : dayEnd;
    const diffMs = windowEnd.getTime() - current.getTime();
    totalMinutes += diffMs / (60 * 1000);

    current = windowEnd;
  }

  return Math.round(totalMinutes);
}

/**
 * Calculates initial response and resolution deadlines for a new ticket.
 */
export function calculateInitialDeadlines(createdAt, priority, holidays = [], slaConfig = DEFAULT_SLA_CONFIG) {
  const conf = slaConfig[priority] || slaConfig['medium'];

  // Response Deadline
  const responseDeadline = addWorkingMinutes(createdAt, conf.first_reply_minutes, holidays);

  // Resolution Deadline
  let resolutionDeadline;
  if (conf.resolve_type === 'same_working_day') {
    resolutionDeadline = calculateSameWorkingDayDeadline(createdAt, holidays);
  } else {
    resolutionDeadline = addWorkingMinutes(createdAt, conf.resolve_minutes, holidays);
  }

  return {
    responseDeadline,
    resolutionDeadline
  };
}

/**
 * Recalculates deadlines when priority is changed.
 * - Preserves original creation time and total paused working minutes.
 * - Recalculates deadlines using the new priority targets.
 * - Checks if the new deadline has already passed (marked late immediately).
 * - A downgrade NEVER removes an existing breach.
 */
export function recalculateOnPriorityChange({
  createdAt,
  newPriority,
  totalPausedMinutes = 0,
  holidays = [],
  slaConfig = DEFAULT_SLA_CONFIG,
  currentTime = new Date(),
  currentResponseBreached = false,
  currentResolutionBreached = false,
  firstPublicReplyAt = null,
  resolvedAt = null
}) {
  const conf = slaConfig[newPriority] || slaConfig['medium'];

  // Base deadlines from creation time
  let baseResponseDeadline = addWorkingMinutes(createdAt, conf.first_reply_minutes, holidays);
  let baseResolutionDeadline;
  if (conf.resolve_type === 'same_working_day') {
    baseResolutionDeadline = calculateSameWorkingDayDeadline(createdAt, holidays);
  } else {
    baseResolutionDeadline = addWorkingMinutes(createdAt, conf.resolve_minutes, holidays);
  }

  // Extend by previously paused working minutes
  const newResponseDeadline = totalPausedMinutes > 0
    ? addWorkingMinutes(baseResponseDeadline, totalPausedMinutes, holidays)
    : baseResponseDeadline;

  const newResolutionDeadline = totalPausedMinutes > 0
    ? addWorkingMinutes(baseResolutionDeadline, totalPausedMinutes, holidays)
    : baseResolutionDeadline;

  // Breach checks: downgrade never removes existing breach
  let responseBreached = currentResponseBreached;
  if (!responseBreached && !firstPublicReplyAt && currentTime > newResponseDeadline) {
    responseBreached = true;
  }

  let resolutionBreached = currentResolutionBreached;
  if (!resolutionBreached && !resolvedAt && currentTime > newResolutionDeadline) {
    resolutionBreached = true;
  }

  return {
    responseDeadline: newResponseDeadline,
    resolutionDeadline: newResolutionDeadline,
    responseBreached,
    resolutionBreached
  };
}

/**
 * Checks if a ticket waiting on customer should auto-close (5 working days = 2700 working minutes).
 */
export function isAutoCloseDue(waitingSince, currentTime = new Date(), holidays = []) {
  if (!waitingSince) return false;
  const elapsedWorkingMinutes = calculateElapsedWorkingMinutes(waitingSince, currentTime, holidays);
  return elapsedWorkingMinutes >= 5 * WORK_MINUTES_PER_DAY;
}

/**
 * Checks if a resolved ticket is within the 5-working-day reopen window.
 */
export function isWithinReopenWindow(resolvedAt, currentTime = new Date(), holidays = []) {
  if (!resolvedAt) return false;
  const elapsedWorkingMinutes = calculateElapsedWorkingMinutes(resolvedAt, currentTime, holidays);
  return elapsedWorkingMinutes <= 5 * WORK_MINUTES_PER_DAY;
}
