const startOfDay = (date) => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const isSameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();

module.exports = {
  startOfDay,
  isSameDay,
};
