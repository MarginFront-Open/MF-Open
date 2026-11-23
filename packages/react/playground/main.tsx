import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Import the source styles directly for development
import '../src/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
