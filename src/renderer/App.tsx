import { h } from 'preact';
import { useBot } from './hooks/useBot';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { Dashboard } from './components/Dashboard';
import { Settings } from './components/Settings';
import { Queue } from './components/Queue';
import { Log } from './components/Log';

export function App() {
  const bot = useBot();

  if (!bot.ready) return null;

  let content;
  switch (bot.view) {
    case 'dashboard':
      content = <Dashboard status={bot.status} />;
      break;
    case 'settings':
      content = <Settings settings={bot.settings} onSave={bot.saveSettings} onClear={bot.clearSession} />;
      break;
    case 'queue':
      content = (
        <Queue
          queueTab={bot.queueTab}
          setQueueTab={bot.setQueueTab}
          status={bot.status}
          followers={bot.followers}
          nextFollowIndex={bot.nextFollowIndex}
        />
      );
      break;
    case 'log':
      content = <Log logs={bot.logs} logFilter={bot.logFilter} setLogFilter={bot.setLogFilter} />;
      break;
  }

  return (
    <div class="app-shell">
      <Sidebar view={bot.view} setView={bot.setView} status={bot.status} />
      <div class="main-content">
        <Header
          view={bot.view}
          status={bot.status}
          settings={bot.settings}
          onStart={bot.startBot}
          onStop={bot.stopBot}
          onScrape={bot.startScraping}
        />
        <div class="content-body fade-in" key={bot.view}>
          {content}
        </div>
      </div>
    </div>
  );
}
