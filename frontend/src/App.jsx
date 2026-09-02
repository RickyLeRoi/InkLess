// frontend/src/App.jsx

import { useState } from 'react';
import { Board } from './components/Board.jsx';
import { Carousel } from './components/Carousel.jsx';
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
        <>
          <p className="intro">
            InkLess è una bacheca a metà fra il digitale e la carta. Scrivi un messaggio, massimo
            200 caratteri: se supera la moderazione compare qui sotto, in bacheca. Da quel momento
            chiunque può farlo uscire davvero da una stampante termica a casa mia con una piccola
            donazione — da 50 centesimi lo stampo, da un euro ti mando anche il video della stampa.
          </p>

          <SubmitForm onSubmitted={refresh} />
          <MyMessages reloadToken={reloadToken} />

          <Carousel onPrint={setPrinting} reloadToken={reloadToken} />
        </>
      ) : null}

      {path === 'bacheca' ? (
        <Board onPrint={setPrinting} reloadToken={reloadToken} focusId={params[0]} />
      ) : null}

      {path === 'job' ? <JobPage jobId={params[0]} /> : null}

      {path === 'admin' ? <AdminPage /> : null}

      {printing ? <PrintDialog message={printing} onClose={() => setPrinting(null)} /> : null}
    </div>
  );
}
