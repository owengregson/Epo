const { useEffect, useMemo, useState, useCallback } = React;

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const formatNumber = (num) => {
  if (num === null || num === undefined) return '—';
  return num.toLocaleString();
};

// ─────────────────────────────────────────────────────────────────────────────
// Component Helpers
// ─────────────────────────────────────────────────────────────────────────────

const h = React.createElement;

const Icon = ({ children }) => h('span', { className: 'nav-item-icon' }, children);

// ─────────────────────────────────────────────────────────────────────────────
// Main App Component
// ─────────────────────────────────────────────────────────────────────────────

const App = () => {
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [targets, setTargets] = useState({ followerList: [], nextFollowIndex: 0 });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ text: '', type: 'success' });
  const [activeView, setActiveView] = useState('dashboard');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // ─────────────────────────────────────────────────────────────────────────
  // Data Fetching
  // ─────────────────────────────────────────────────────────────────────────

  const refreshAll = useCallback(async () => {
    try {
      const [settingsData, statusData, targetsData] = await Promise.all([
        window.peanut.getSettings(),
        window.peanut.getStatus(),
        window.peanut.getTargets(),
      ]);
      setSettings(settingsData);
      setStatus(statusData);
      setTargets(targetsData);
    } catch (error) {
      showMessage('Failed to refresh data', 'error');
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const [statusData, targetsData] = await Promise.all([
        window.peanut.getStatus(),
        window.peanut.getTargets(),
      ]);
      setStatus(statusData);
      setTargets(targetsData);
    } catch (error) {
      // Silent fail for periodic updates
    }
  }, []);

  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshStatus, 5000);
    return () => clearInterval(interval);
  }, [refreshAll, refreshStatus]);

  // ─────────────────────────────────────────────────────────────────────────
  // Message Handling
  // ─────────────────────────────────────────────────────────────────────────

  const showMessage = useCallback((text, type = 'success') => {
    setMessage({ text, type });
    setTimeout(() => setMessage({ text: '', type: 'success' }), 3000);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Settings Handlers
  // ─────────────────────────────────────────────────────────────────────────

  const handleFieldChange = useCallback((key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!settings) return;
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
      showMessage('Settings saved successfully');
      await refreshAll();
    } catch (error) {
      showMessage('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  }, [settings, refreshAll, showMessage]);

  // ─────────────────────────────────────────────────────────────────────────
  // Bot Control Handlers
  // ─────────────────────────────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    try {
      await window.peanut.startBot();
      showMessage('Bot started');
      await refreshAll();
    } catch (error) {
      showMessage('Failed to start bot', 'error');
    }
  }, [refreshAll, showMessage]);

  const handleStop = useCallback(async () => {
    try {
      await window.peanut.stopBot();
      showMessage('Bot stopped');
      await refreshAll();
    } catch (error) {
      showMessage('Failed to stop bot', 'error');
    }
  }, [refreshAll, showMessage]);

  const handleRefreshFollowers = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await window.peanut.refreshFollowers();
      showMessage('Followers refreshed');
      await refreshAll();
    } catch (error) {
      showMessage('Failed to refresh followers', 'error');
    } finally {
      setIsRefreshing(false);
    }
  }, [refreshAll, showMessage]);

  const handleClear = useCallback(async () => {
    try {
      await window.peanut.clearSession();
      showMessage('Session cleared');
      await refreshAll();
    } catch (error) {
      showMessage('Failed to clear session', 'error');
    }
  }, [refreshAll, showMessage]);

  const handleHeadlessToggle = useCallback(async (value) => {
    try {
      const headless = await window.peanut.toggleHeadless(value);
      setSettings((prev) => ({ ...prev, headless }));
      showMessage(headless ? 'Browser hidden' : 'Browser visible');
    } catch (error) {
      showMessage('Failed to toggle visibility', 'error');
    }
  }, [showMessage]);

  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refreshAll();
    setIsRefreshing(false);
  }, [refreshAll]);

  // ─────────────────────────────────────────────────────────────────────────
  // Computed Values
  // ─────────────────────────────────────────────────────────────────────────

  // Fix: Show up to 50 targets starting from nextFollowIndex
  const previewTargets = useMemo(() => {
    const startIndex = targets.nextFollowIndex || 0;
    const list = targets.followerList || [];
    return list.slice(startIndex, startIndex + 50).map((target, i) => ({
      ...target,
      absoluteIndex: startIndex + i,
    }));
  }, [targets]);

  // ─────────────────────────────────────────────────────────────────────────
  // Loading State
  // ─────────────────────────────────────────────────────────────────────────

  if (!settings || !status) {
    return h('div', { className: 'app-shell loading' },
      h('div', { className: 'loading-spinner' }),
      h('span', { className: 'loading-text' }, 'Loading Peanut Control Center...')
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render Sidebar
  // ─────────────────────────────────────────────────────────────────────────

  const renderSidebar = () => h('aside', { className: 'sidebar' },
    // Header
    h('div', { className: 'sidebar-header' },
      h('div', { className: 'sidebar-brand' },
        h('div', { className: 'sidebar-logo' }, '\uD83E\uDD5C'),
        h('div', { className: 'sidebar-title' },
          h('h1', null, 'Peanut'),
          h('span', null, 'Control Center')
        )
      )
    ),

    // Status Badge
    h('div', { className: 'sidebar-status' },
      h('div', { className: `status-indicator ${status.running ? 'running' : 'stopped'}` },
        h('span', { className: 'status-dot' }),
        h('span', null, status.running ? 'Running' : 'Stopped')
      )
    ),

    // Navigation
    h('nav', { className: 'sidebar-nav' },
      h('div', {
        className: `nav-item ${activeView === 'dashboard' ? 'active' : ''}`,
        onClick: () => setActiveView('dashboard')
      },
        h(Icon, null, '\uD83D\uDCCA'),
        h('span', null, 'Dashboard')
      ),
      h('div', {
        className: `nav-item ${activeView === 'settings' ? 'active' : ''}`,
        onClick: () => setActiveView('settings')
      },
        h(Icon, null, '\u2699\uFE0F'),
        h('span', null, 'Settings')
      ),
      h('div', {
        className: `nav-item ${activeView === 'targets' ? 'active' : ''}`,
        onClick: () => setActiveView('targets')
      },
        h(Icon, null, '\uD83C\uDFAF'),
        h('span', null, 'Target Queue')
      )
    ),

    // Footer
    h('div', { className: 'sidebar-footer' },
      h('div', { className: 'sidebar-footer-info' },
        'v1.0.0'
      )
    )
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Render Dashboard View
  // ─────────────────────────────────────────────────────────────────────────

  const renderDashboard = () => h('div', { className: 'panel-grid' },
    // Session Status Panel
    h('div', { className: 'panel animate-slide-up' },
      h('div', { className: 'panel-header' },
        h('div', { className: 'panel-header-title' },
          h('div', { className: 'panel-icon' }, '\uD83D\uDCE1'),
          h('div', null,
            h('div', { className: 'panel-title' }, 'Session Status'),
            h('div', { className: 'panel-subtitle' }, 'Current automation state')
          )
        )
      ),
      h('div', { className: 'panel-body' },
        h('div', { className: 'stats-grid' },
          h('div', { className: 'stat-card' },
            h('span', { className: 'stat-label' }, 'Target Account'),
            h('div', { className: 'stat-value mono' }, status.target || 'Not set')
          ),
          h('div', { className: 'stat-card' },
            h('span', { className: 'stat-label' }, 'Last Action'),
            h('div', { className: 'stat-value mono' }, status.lastAction || 'None')
          ),
          h('div', { className: 'stat-card' },
            h('span', { className: 'stat-label' }, 'Queued Follows'),
            h('div', { className: 'stat-value accent' }, formatNumber(status.queuedFollows))
          ),
          h('div', { className: 'stat-card' },
            h('span', { className: 'stat-label' }, 'Pending Unfollows'),
            h('div', { className: 'stat-value' }, formatNumber(status.pendingUnfollows))
          )
        ),
        h('div', { className: 'divider' }),
        h('div', { className: 'stats-grid' },
          h('div', { className: 'stat-card' },
            h('span', { className: 'stat-label' }, 'Next Follow'),
            h('div', { className: 'stat-value mono' }, formatDateTime(status.nextFollowAt))
          ),
          h('div', { className: 'stat-card' },
            h('span', { className: 'stat-label' }, 'Next Unfollow'),
            h('div', { className: 'stat-value mono' }, formatDateTime(status.nextUnfollowAt))
          ),
          h('div', { className: 'stat-card' },
            h('span', { className: 'stat-label' }, 'Follower Pool'),
            h('div', { className: 'stat-value success' }, formatNumber(status.followerCount))
          ),
          h('div', { className: 'stat-card' },
            h('span', { className: 'stat-label' }, 'Next Index'),
            h('div', { className: 'stat-value' }, formatNumber(status.nextFollowIndex))
          )
        )
      ),
      h('div', { className: 'panel-footer' },
        h('div', { className: 'btn-group' },
          h('button', {
            className: 'btn btn-success',
            onClick: handleStart,
            disabled: status.running
          }, '\u25B6 Start'),
          h('button', {
            className: 'btn btn-secondary',
            onClick: handleStop,
            disabled: !status.running
          }, '\u25A0 Stop')
        ),
        h('div', { className: 'btn-group' },
          h('button', {
            className: 'btn btn-secondary',
            onClick: handleRefreshFollowers,
            disabled: isRefreshing
          }, isRefreshing ? 'Refreshing...' : '\u21BB Refresh Followers'),
          h('button', {
            className: 'btn btn-danger',
            onClick: handleClear
          }, 'Clear Session')
        )
      )
    ),

    // Quick Settings Panel
    h('div', { className: 'panel animate-slide-up' },
      h('div', { className: 'panel-header' },
        h('div', { className: 'panel-header-title' },
          h('div', { className: 'panel-icon' }, '\u26A1'),
          h('div', null,
            h('div', { className: 'panel-title' }, 'Quick Controls'),
            h('div', { className: 'panel-subtitle' }, 'Toggle common settings')
          )
        )
      ),
      h('div', { className: 'panel-body' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          h('div', { className: 'toggle-row' },
            h('div', { className: 'toggle-info' },
              h('span', { className: 'toggle-label' }, 'Dry Run Mode'),
              h('span', { className: 'toggle-desc' }, 'Simulate actions without executing')
            ),
            h('input', {
              type: 'checkbox',
              className: 'toggle-switch',
              checked: settings.dryRun,
              onChange: (e) => handleFieldChange('dryRun', e.target.checked)
            })
          ),
          h('div', { className: 'toggle-row' },
            h('div', { className: 'toggle-info' },
              h('span', { className: 'toggle-label' }, 'Browser Visible'),
              h('span', { className: 'toggle-desc' }, 'Show Instagram browser window')
            ),
            h('input', {
              type: 'checkbox',
              className: 'toggle-switch',
              checked: !settings.headless,
              onChange: (e) => handleHeadlessToggle(!e.target.checked)
            })
          )
        ),
        h('div', { className: 'divider' }),
        h('div', { className: 'notice' },
          h('span', { className: 'notice-icon' }, '\u2139\uFE0F'),
          h('span', null, 'Changes to toggles are applied immediately. Use the Settings page for full configuration.')
        )
      ),
      h('div', { className: 'panel-footer' },
        h('button', {
          className: 'btn btn-primary',
          onClick: handleSave,
          disabled: saving
        }, saving ? 'Saving...' : 'Save Changes'),
        message.text && h('span', { className: `toast ${message.type === 'error' ? 'error' : ''}` }, message.text)
      )
    )
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Render Settings View
  // ─────────────────────────────────────────────────────────────────────────

  const renderSettings = () => h('div', { className: 'panel-grid-full' },
    h('div', { className: 'panel animate-slide-up' },
      h('div', { className: 'panel-header' },
        h('div', { className: 'panel-header-title' },
          h('div', { className: 'panel-icon' }, '\u2699\uFE0F'),
          h('div', null,
            h('div', { className: 'panel-title' }, 'Configuration'),
            h('div', { className: 'panel-subtitle' }, 'Automation parameters and limits')
          )
        )
      ),
      h('div', { className: 'panel-body' },
        h('div', { className: 'form-grid' },
          h('div', { className: 'form-group' },
            h('label', { className: 'form-label' }, 'Target Account'),
            h('input', {
              type: 'text',
              className: 'form-input',
              value: settings.target || '',
              onChange: (e) => handleFieldChange('target', e.target.value),
              placeholder: 'username'
            }),
            h('span', { className: 'form-hint' }, 'Instagram account to scrape followers from')
          ),
          h('div', { className: 'form-group' },
            h('label', { className: 'form-label' }, 'Daily Follow Limit'),
            h('input', {
              type: 'number',
              className: 'form-input',
              min: 1,
              max: 200,
              value: settings.dailyFollowLimit || '',
              onChange: (e) => handleFieldChange('dailyFollowLimit', e.target.value)
            }),
            h('span', { className: 'form-hint' }, 'Maximum follows per day (recommended: 20-50)')
          ),
          h('div', { className: 'form-group' },
            h('label', { className: 'form-label' }, 'Follow Interval (min)'),
            h('input', {
              type: 'number',
              className: 'form-input',
              min: 1,
              value: settings.followIntervalMinutes || '',
              onChange: (e) => handleFieldChange('followIntervalMinutes', e.target.value)
            }),
            h('span', { className: 'form-hint' }, 'Minutes between each follow action')
          ),
          h('div', { className: 'form-group' },
            h('label', { className: 'form-label' }, 'Scheduler Interval (min)'),
            h('input', {
              type: 'number',
              className: 'form-input',
              min: 1,
              value: settings.schedulerIntervalMinutes || '',
              onChange: (e) => handleFieldChange('schedulerIntervalMinutes', e.target.value)
            }),
            h('span', { className: 'form-hint' }, 'How often the scheduler checks for due tasks')
          ),
          h('div', { className: 'form-group' },
            h('label', { className: 'form-label' }, 'Min Following Count'),
            h('input', {
              type: 'number',
              className: 'form-input',
              min: 0,
              value: settings.minFollowingCount || '',
              onChange: (e) => handleFieldChange('minFollowingCount', e.target.value)
            }),
            h('span', { className: 'form-hint' }, 'Only follow users with at least this many following')
          ),
          h('div', { className: 'form-group' },
            h('label', { className: 'form-label' }, 'Slow Mo (ms)'),
            h('input', {
              type: 'number',
              className: 'form-input',
              min: 0,
              value: settings.slowMo || '',
              onChange: (e) => handleFieldChange('slowMo', e.target.value)
            }),
            h('span', { className: 'form-hint' }, 'Delay between browser actions for stealth')
          )
        ),
        h('div', { className: 'divider' }),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' } },
          h('div', { className: 'toggle-row' },
            h('div', { className: 'toggle-info' },
              h('span', { className: 'toggle-label' }, 'Dry Run Mode'),
              h('span', { className: 'toggle-desc' }, 'Test automation without real actions')
            ),
            h('input', {
              type: 'checkbox',
              className: 'toggle-switch',
              checked: settings.dryRun,
              onChange: (e) => handleFieldChange('dryRun', e.target.checked)
            })
          ),
          h('div', { className: 'toggle-row' },
            h('div', { className: 'toggle-info' },
              h('span', { className: 'toggle-label' }, 'Browser Visible'),
              h('span', { className: 'toggle-desc' }, 'Show the Instagram browser window')
            ),
            h('input', {
              type: 'checkbox',
              className: 'toggle-switch',
              checked: !settings.headless,
              onChange: (e) => handleHeadlessToggle(!e.target.checked)
            })
          )
        )
      ),
      h('div', { className: 'panel-footer' },
        h('button', {
          className: 'btn btn-primary',
          onClick: handleSave,
          disabled: saving
        }, saving ? 'Saving...' : 'Save Settings'),
        message.text && h('span', { className: `toast ${message.type === 'error' ? 'error' : ''}` }, message.text)
      )
    )
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Render Targets View
  // ─────────────────────────────────────────────────────────────────────────

  const renderTargets = () => h('div', { className: 'panel-grid-full' },
    h('div', { className: 'panel animate-slide-up' },
      h('div', { className: 'panel-header' },
        h('div', { className: 'panel-header-title' },
          h('div', { className: 'panel-icon' }, '\uD83C\uDFAF'),
          h('div', null,
            h('div', { className: 'panel-title' }, 'Target Queue'),
            h('div', { className: 'panel-subtitle' },
              `${formatNumber(targets.followerList?.length || 0)} accounts loaded`
            )
          )
        ),
        h('button', {
          className: 'btn btn-secondary',
          onClick: handleRefreshFollowers,
          disabled: isRefreshing
        }, isRefreshing ? 'Refreshing...' : '\u21BB Refresh')
      ),
      h('div', { className: 'panel-body' },
        h('div', { className: 'notice', style: { marginBottom: '16px' } },
          h('span', { className: 'notice-icon' }, '\u2139\uFE0F'),
          h('span', null, 'Accounts are sorted by following count (highest first). The next account to follow is highlighted.')
        ),
        previewTargets.length === 0
          ? h('div', { className: 'empty-state' },
              h('div', { className: 'empty-state-icon' }, '\uD83D\uDCED'),
              h('div', { className: 'empty-state-title' }, 'No targets loaded'),
              h('div', { className: 'empty-state-desc' }, 'Click "Refresh Followers" to load the target queue from your configured account.')
            )
          : h('div', { className: 'target-list' },
              previewTargets.map((target, index) => {
                const isNext = target.absoluteIndex === targets.nextFollowIndex;
                return h('div', {
                  key: `${target.username}-${target.absoluteIndex}`,
                  className: `target-item ${isNext ? 'current' : ''}`
                },
                  h('div', { className: 'target-rank' }, target.absoluteIndex + 1),
                  h('div', { className: 'target-info' },
                    h('div', { className: 'target-username' }, `@${target.username}`),
                    h('div', { className: 'target-meta' }, `${formatNumber(target.followingCount)} following`)
                  ),
                  isNext && h('span', { className: 'target-badge' }, 'Next')
                );
              })
            )
      )
    )
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Render Main Content
  // ─────────────────────────────────────────────────────────────────────────

  const getViewTitle = () => {
    switch (activeView) {
      case 'dashboard': return { title: 'Dashboard', subtitle: 'Overview of your automation status' };
      case 'settings': return { title: 'Settings', subtitle: 'Configure automation parameters' };
      case 'targets': return { title: 'Target Queue', subtitle: 'Manage your follow targets' };
      default: return { title: 'Dashboard', subtitle: '' };
    }
  };

  const viewInfo = getViewTitle();

  return h('div', { className: 'app-shell' },
    renderSidebar(),
    h('main', { className: 'main-content' },
      h('div', { className: 'top-bar' },
        h('div', { className: 'top-bar-title' },
          h('h2', null, viewInfo.title),
          h('span', null, viewInfo.subtitle)
        ),
        h('div', { className: 'top-bar-actions' },
          h('button', {
            className: 'btn btn-ghost btn-icon',
            onClick: handleManualRefresh,
            disabled: isRefreshing,
            title: 'Refresh data'
          }, '\u21BB')
        )
      ),
      h('div', { className: 'content-area' },
        activeView === 'dashboard' && renderDashboard(),
        activeView === 'settings' && renderSettings(),
        activeView === 'targets' && renderTargets()
      )
    )
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Initialize App
// ─────────────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById('root')).render(h(App));
