const { useEffect, useMemo, useState } = React;

const formatDateTime = (value) => {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString();
};

const App = () => {
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [targets, setTargets] = useState({ followerList: [], nextFollowIndex: 0 });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const refreshAll = async () => {
    const [settingsData, statusData, targetsData] = await Promise.all([
      window.peanut.getSettings(),
      window.peanut.getStatus(),
      window.peanut.getTargets(),
    ]);
    setSettings(settingsData);
    setStatus(statusData);
    setTargets(targetsData);
  };

  useEffect(() => {
    refreshAll();
    const interval = setInterval(() => {
      window.peanut.getStatus().then(setStatus);
      window.peanut.getTargets().then(setTargets);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleFieldChange = (key, value) => {
    setSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleSave = async () => {
    if (!settings) {
      return;
    }
    setSaving(true);
    try {
      await window.peanut.updateSettings({
        target: settings.target,
        followIntervalMinutes: Number(settings.followIntervalMinutes),
        dailyFollowLimit: Number(settings.dailyFollowLimit),
        minFollowingCount: Number(settings.minFollowingCount),
        schedulerIntervalMinutes: Number(settings.schedulerIntervalMinutes),
        slowMo: Number(settings.slowMo),
        dryRun: Boolean(settings.dryRun),
      });
      setMessage('Settings saved.');
      await refreshAll();
    } finally {
      setSaving(false);
      setTimeout(() => setMessage(''), 2000);
    }
  };

  const handleStart = async () => {
    await window.peanut.startBot();
    await refreshAll();
  };

  const handleStop = async () => {
    await window.peanut.stopBot();
    await refreshAll();
  };

  const handleRefreshFollowers = async () => {
    await window.peanut.refreshFollowers();
    await refreshAll();
  };

  const handleClear = async () => {
    await window.peanut.clearSession();
    await refreshAll();
  };

  const handleHeadlessToggle = async (value) => {
    const headless = await window.peanut.toggleHeadless(value);
    setSettings((prev) => ({
      ...prev,
      headless,
    }));
    await refreshAll();
  };

  const previewTargets = useMemo(() => targets.followerList.slice(0, 40), [targets]);

  if (!settings || !status) {
    return React.createElement('div', { className: 'app-shell' }, 'Loading Peanut Control Center...');
  }

  return React.createElement(
    'div',
    { className: 'app-shell' },
    React.createElement(
      'header',
      { className: 'app-header' },
      React.createElement(
        'div',
        { className: 'header-title' },
        React.createElement('h1', null, 'Peanut Control Center'),
        React.createElement('span', null, 'Automate your Instagram growth with clarity and control.')
      ),
      React.createElement(
        'div',
        { className: 'header-actions' },
        React.createElement(
          'div',
          { className: `status-pill ${status.running ? 'running' : 'stopped'}` },
          status.running ? 'Running' : 'Stopped'
        ),
        React.createElement(
          'button',
          { className: 'button secondary', onClick: refreshAll },
          'Refresh'
        )
      )
    ),
    React.createElement(
      'div',
      { className: 'grid' },
      React.createElement(
        'section',
        { className: 'card' },
        React.createElement('h2', null, 'Session Status'),
        React.createElement(
          'div',
          { className: 'kpi-grid' },
          React.createElement(
            'div',
            { className: 'kpi' },
            React.createElement('span', null, 'Target'),
            React.createElement('strong', null, status.target || 'Not set')
          ),
          React.createElement(
            'div',
            { className: 'kpi' },
            React.createElement('span', null, 'Last Action'),
            React.createElement('strong', { className: status.running ? 'pulse' : null }, status.lastAction)
          ),
          React.createElement(
            'div',
            { className: 'kpi' },
            React.createElement('span', null, 'Queued Follows'),
            React.createElement('strong', null, status.queuedFollows)
          ),
          React.createElement(
            'div',
            { className: 'kpi' },
            React.createElement('span', null, 'Pending Unfollows'),
            React.createElement('strong', null, status.pendingUnfollows)
          )
        ),
        React.createElement(
          'div',
          { className: 'kpi-grid', style: { marginTop: '16px' } },
          React.createElement(
            'div',
            { className: 'kpi' },
            React.createElement('span', null, 'Next Follow'),
            React.createElement('strong', null, formatDateTime(status.nextFollowAt))
          ),
          React.createElement(
            'div',
            { className: 'kpi' },
            React.createElement('span', null, 'Next Unfollow'),
            React.createElement('strong', null, formatDateTime(status.nextUnfollowAt))
          ),
          React.createElement(
            'div',
            { className: 'kpi' },
            React.createElement('span', null, 'Follower Pool'),
            React.createElement('strong', null, status.followerCount)
          ),
          React.createElement(
            'div',
            { className: 'kpi' },
            React.createElement('span', null, 'Next Index'),
            React.createElement('strong', null, status.nextFollowIndex)
          )
        ),
        React.createElement(
          'div',
          { className: 'footer-actions', style: { marginTop: '16px' } },
          React.createElement(
            'button',
            { className: 'button', onClick: handleStart, disabled: status.running },
            'Start'
          ),
          React.createElement(
            'button',
            { className: 'button secondary', onClick: handleStop, disabled: !status.running },
            'Stop'
          ),
          React.createElement(
            'button',
            { className: 'button secondary', onClick: handleRefreshFollowers },
            'Refresh Followers'
          ),
          React.createElement(
            'button',
            { className: 'button ghost', onClick: handleClear },
            'Clear Session'
          )
        )
      ),
      React.createElement(
        'section',
        { className: 'card' },
        React.createElement('h2', null, 'Configuration'),
        React.createElement(
          'div',
          { className: 'field-group' },
          React.createElement(
            'label',
            null,
            'Target Account',
            React.createElement('input', {
              type: 'text',
              value: settings.target,
              onChange: (event) => handleFieldChange('target', event.target.value),
              placeholder: 'username',
            })
          ),
          React.createElement(
            'label',
            null,
            'Daily Follow Limit',
            React.createElement('input', {
              type: 'number',
              min: 1,
              value: settings.dailyFollowLimit,
              onChange: (event) => handleFieldChange('dailyFollowLimit', event.target.value),
            })
          ),
          React.createElement(
            'label',
            null,
            'Follow Interval (min)',
            React.createElement('input', {
              type: 'number',
              min: 1,
              value: settings.followIntervalMinutes,
              onChange: (event) => handleFieldChange('followIntervalMinutes', event.target.value),
            })
          ),
          React.createElement(
            'label',
            null,
            'Scheduler Interval (min)',
            React.createElement('input', {
              type: 'number',
              min: 1,
              value: settings.schedulerIntervalMinutes,
              onChange: (event) => handleFieldChange('schedulerIntervalMinutes', event.target.value),
            })
          ),
          React.createElement(
            'label',
            null,
            'Min Following Count',
            React.createElement('input', {
              type: 'number',
              min: 1,
              value: settings.minFollowingCount,
              onChange: (event) => handleFieldChange('minFollowingCount', event.target.value),
            })
          ),
          React.createElement(
            'label',
            null,
            'Slow Mo (ms)',
            React.createElement('input', {
              type: 'number',
              min: 0,
              value: settings.slowMo,
              onChange: (event) => handleFieldChange('slowMo', event.target.value),
            })
          )
        ),
        React.createElement(
          'div',
          { style: { display: 'grid', gap: '12px', marginTop: '16px' } },
          React.createElement(
            'div',
            { className: 'toggle' },
            React.createElement('span', null, 'Dry Run Mode'),
            React.createElement('input', {
              type: 'checkbox',
              checked: settings.dryRun,
              onChange: (event) => handleFieldChange('dryRun', event.target.checked),
            })
          ),
          React.createElement(
            'div',
            { className: 'toggle' },
            React.createElement('span', null, 'Instagram Tab Visible'),
            React.createElement('input', {
              type: 'checkbox',
              checked: !settings.headless,
              onChange: (event) => handleHeadlessToggle(!event.target.checked),
            })
          )
        ),
        React.createElement(
          'div',
          { className: 'footer-actions', style: { marginTop: '16px' } },
          React.createElement(
            'button',
            { className: 'button', onClick: handleSave, disabled: saving },
            saving ? 'Saving...' : 'Save Settings'
          ),
          React.createElement(
            'span',
            { className: 'badge' },
            message
          )
        )
      ),
      React.createElement(
        'section',
        { className: 'card' },
        React.createElement('h2', null, 'Target Queue'),
        React.createElement(
          'div',
          { className: 'notice' },
          'Preview of the next accounts Peanut plans to follow, ordered by following count.'
        ),
        React.createElement(
          'div',
          { className: 'list', style: { marginTop: '16px' } },
          previewTargets.length === 0
            ? React.createElement('div', { className: 'notice' }, 'No targets loaded yet.')
            : previewTargets.map((target, index) =>
              React.createElement(
                'div',
                { key: `${target.username}-${index}`, className: 'list-item' },
                React.createElement('div', null, `@${target.username}`),
                React.createElement(
                  'span',
                  null,
                  `${target.followingCount} following`
                ),
                index === targets.nextFollowIndex
                  ? React.createElement('span', { className: 'chip' }, 'Next')
                  : null
              )
            )
        )
      )
    )
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
