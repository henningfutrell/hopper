import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import { applyTheme } from './hooks/use-theme';
import { loginCodeFromHash, submitLogin } from './lib/login';
import './index.css';

applyTheme();

// A device link: drop the code from the address bar and history, then log in with it.
const linkCode = loginCodeFromHash(location.hash);
if (linkCode) {
  history.replaceState(null, '', location.pathname + location.search);
  submitLogin(linkCode);
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
createRoot(root).render(<StrictMode><App /></StrictMode>);
