import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

// Swatches mirror the palettes defined as [data-theme] blocks in index.css.
const THEMES = [
  { id: 'sand', name: 'Sand', colors: ['#a4243b', '#d8c99b', '#d8973c', '#bd632f', '#273e47'] },
  { id: 'plum', name: 'Plum', colors: ['#bfc3ba', '#a9aca9', '#60495a', '#3f3244', '#2f2235'] },
  { id: 'lagoon', name: 'Lagoon', colors: ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'] },
  { id: 'ocean', name: 'Ocean', colors: ['#8ecae6', '#219ebc', '#023047', '#ffb703', '#fb8500'] },
  { id: 'olive', name: 'Olive', colors: ['#606c38', '#283618', '#fefae0', '#dda15e', '#bc6c25'] },
  { id: 'ember', name: 'Ember', colors: ['#003049', '#d62828', '#f77f00', '#fcbf49', '#eae2b7'] },
];
const DEFAULT_THEME = 'sand';

function savedTheme() {
  try {
    return localStorage.getItem('theme') || DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export default function ThemePicker() {
  const [theme, setTheme] = useState(savedTheme);
  const [open, setOpen] = useState(false);
  const root = useRef(null);

  useEffect(() => {
    if (theme === DEFAULT_THEME) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      // Storage can be unavailable (private mode); the theme still applies for this visit.
    }
  }, [theme]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.type === 'keydown' ? event.key === 'Escape' : !root.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div className="theme-picker" ref={root}>
      <button
        className="btn btn-secondary btn-icon"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="theme-menu"
        aria-label="Change color theme"
        title="Change color theme"
      >
        <Icon name="palette" />
      </button>
      {open && (
        <ul id="theme-menu" className="theme-menu" role="radiogroup" aria-label="Color theme">
          {THEMES.map((option) => (
            <li key={option.id}>
              <button
                className="theme-option"
                role="radio"
                aria-checked={theme === option.id}
                onClick={() => {
                  setTheme(option.id);
                  setOpen(false);
                }}
              >
                {option.name}
                <span className="swatches" aria-hidden="true">
                  {option.colors.map((color) => (
                    <span key={color} style={{ background: color }} />
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
