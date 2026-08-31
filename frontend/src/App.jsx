// frontend/src/App.jsx

import { useState } from 'react';
import { Board } from './components/Board.jsx';
import { MyMessages } from './components/MyMessages.jsx';
import { PrintDialog } from './components/PrintDialog.jsx';
import { SubmitForm } from './components/SubmitForm.jsx';
import { AdminPage } from './pages/AdminPage.jsx';
import { JobPage } from './pages/JobPage.jsx';
import { useRoute } from './router.js';

const NAV = [
  { href: '#/', label: 'Home', path: '' },
  { href: '#/bacheca', label: 'Bacheca', path: 'bacheca' }
];

export function App() {
  const { path, params } = useRoute();
  const [printing, setPrinting] = useState(/** @type {any} */ (null));
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = () => setReloadToken((token) => token + 1);

  return (
    <div className="shell">
      <header className="masthead">
        <h1>InkLess</h1>
        <nav>
          {NAV.map((entry) => (
            <a key={entry.href} href={entry.href} aria-current={path === entry.path ? 'page' : undefined}>
              {entry.label}
            </a>
          ))}
        </nav>
      </header>

      {path === '' ? (
        <div className="columns">
          <div>
            <p className="intro">
              Scrivi un messaggio, massimo 200 caratteri. Se passa la moderazione finisce sulla
              bacheca digitale. Da lì chiunque, con una piccola donazione, può farlo uscire davvero
              da una stampante termica a casa mia — e con un euro si porta a casa pure il video.
            </p>
            <SubmitForm onSubmitted={refresh} />
            <MyMessages reloadToken={reloadToken} />
          </div>
          <div>
            <h2>Ultimi in bacheca</h2>
            <Board onPrint={setPrinting} reloadToken={reloadToken} />
          </div>
        </div>
      ) : null}

      {path === 'bacheca' ? <Board onPrint={setPrinting} reloadToken={reloadToken} /> : null}

      {path === 'job' ? <JobPage jobId={params[0]} /> : null}

      {path === 'admin' ? <AdminPage /> : null}

      {printing ? <PrintDialog message={printing} onClose={() => setPrinting(null)} /> : null}
    </div>
  );
}
