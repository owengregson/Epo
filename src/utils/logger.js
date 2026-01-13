const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const levelLabels = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

const resolveLevel = () => {
  const raw = process.env.PEANUT_LOG_LEVEL || 'info';
  return levels[raw] ?? levels.info;
};

const formatMessage = (level, message, meta) => {
  const timestamp = new Date().toISOString();
  const label = levelLabels[level] || 'INFO';
  const base = `[${timestamp}] ${label} ${message}`;
  if (!meta) {
    return base;
  }
  return `${base} ${JSON.stringify(meta)}`;
};

const log = (level, message, meta) => {
  if (levels[level] < resolveLevel()) {
    return;
  }
  const output = formatMessage(level, message, meta);
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(output);
  } else {
    // eslint-disable-next-line no-console
    console.log(output);
  }
};

module.exports = {
  debug: (message, meta) => log('debug', message, meta),
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
