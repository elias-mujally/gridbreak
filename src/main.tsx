import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App';
import './ui/styles.css';
import './ui/mobile.css';
import './ui/rush.css';
import './ui/convergence.css';
import './ui/online.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
