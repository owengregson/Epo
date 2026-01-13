const schedule = require('node-schedule');
const { isSameDay } = require('./utils/time');

const planDailyFollows = ({
  state,
  now,
  dailyLimit,
  followIntervalMs,
  minFollowingCount,
}) => {
  const today = new Date(now);
  if (state.lastDailyPlan && isSameDay(new Date(state.lastDailyPlan), today)) {
    return state;
  }

  const updatedState = {
    ...state,
    lastDailyPlan: today.toISOString(),
  };

  const queue = [];
  let index = updatedState.nextFollowIndex;
  while (queue.length < dailyLimit && index < updatedState.followerList.length) {
    const candidate = updatedState.followerList[index];
    if (candidate.followingCount < minFollowingCount) {
      break;
    }
    const scheduledAt = new Date(today.getTime() + queue.length * followIntervalMs);
    queue.push({ username: candidate.username, scheduledAt: scheduledAt.toISOString() });
    index += 1;
  }

  updatedState.followQueue = queue;
  updatedState.nextFollowIndex = index;
  return updatedState;
};

const takeDueItems = (queue, now) => {
  const due = [];
  const remaining = [];
  queue.forEach((item) => {
    if (new Date(item.scheduledAt).getTime() <= now.getTime()) {
      due.push(item);
    } else {
      remaining.push(item);
    }
  });
  return { due, remaining };
};

const scheduleLoop = ({
  intervalMs,
  onTick,
}) => {
  const interval = setInterval(onTick, intervalMs);
  return () => clearInterval(interval);
};

const scheduleCron = ({
  cronExpression,
  onTick,
}) => schedule.scheduleJob(cronExpression, onTick);

module.exports = {
  planDailyFollows,
  takeDueItems,
  scheduleLoop,
  scheduleCron,
};
