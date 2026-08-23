import { createRoot } from 'react-dom/client';
import App from './App';
import { initAppConfig } from './store/appConfig';
import { applyAppearance, getAppearance } from './store/appearance';
import { applyPlatform } from './platform';
import { interceptExternalLinks } from './external';
import { tameContextMenu } from './contextMenu';
import { scheduleAutoCheck } from './store/updater';
import './styles.css';

// No StrictMode: its double mount puts the CodeMirror instance (with its
// scroll listener and viewRef) through create → destroy → recreate, which
// introduces a race where the old view's dispatch is already dead. Nothing
// here needs the side-effect auditing StrictMode buys.
//
// Read the app config into memory before rendering: the WeChat code is
// written against localStorage's synchronous semantics, and loading it up
// front lets it keep reading synchronously afterwards.
void initAppConfig().then(() => {
  // Three things have to be true before the first paint, or frame one is wrong:
  // the resolved light/dark on <html>, which OS this is, and whether we are
  // inside the Tauri shell. The last two together are what reserve room for the
  // macOS traffic lights — and only there, since Windows and Linux both keep a
  // native title bar and need no such gap.
  applyAppearance(getAppearance());
  applyPlatform();
  // Hand every external link to the system browser — inside the webview a
  // target="_blank" click would otherwise do nothing at all
  interceptExternalLinks();
  // And keep each webview's own "reload / save as / inspect" menu off the
  // chrome, where all three of them offer something different
  tameContextMenu();
  if ('__TAURI_INTERNALS__' in window) document.documentElement.classList.add('is-tauri');

  createRoot(document.getElementById('root')!).render(<App />);

  // Ask GitHub whether there is a newer build — a few seconds from now, at
  // most once every six hours, and without saying anything unless the answer
  // is yes. All it does on its own is light the pill in the toolbar.
  scheduleAutoCheck();
});
