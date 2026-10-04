import { render } from 'preact';
// Readex Pro, self-hosted (the CSP allows same-origin resources only, and the demo must work without internet).
import '@fontsource/readex-pro/latin-300.css';
import '@fontsource/readex-pro/latin-400.css';
import '@fontsource/readex-pro/latin-500.css';
import '@fontsource/readex-pro/latin-600.css';
import '@fontsource/readex-pro/latin-ext-300.css';
import '@fontsource/readex-pro/latin-ext-400.css';
import '@fontsource/readex-pro/latin-ext-500.css';
import '@fontsource/readex-pro/latin-ext-600.css';
import { App } from './App';
import './styles.css';
render(<App />, document.getElementById('app')!);
