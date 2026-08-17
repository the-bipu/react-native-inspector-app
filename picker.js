'use strict';

/*
 * Runs immediately as the parser hits this <script src="picker.js"> tag
 * (near the top of <body>), i.e. before the rest of the page has painted.
 * Reads the theme main.js passed in via the URL query string
 * (?theme=light|dark) and applies it right away so there's no dark-mode
 * flash when the app is in light mode.
 */
(function applyInitialTheme() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
})();

document.addEventListener('DOMContentLoaded', () => {
  let selectedPreset = null;

  const cards     = document.querySelectorAll('.device-card');
  const applyBtn  = document.getElementById('apply-btn');
  const cancelBtn = document.getElementById('cancel-btn');
  const closeBtn  = document.getElementById('close-btn');
  const selName   = document.getElementById('selected-name');

  const LABELS = {
    iphone15pro: 'iPhone 15 Pro',
    pixel8:      'Pixel 8',
    ipadpro11:   'iPad Pro 11"',
    galaxytab:   'Galaxy Tab S9',
    responsive:  'Responsive',
  };

  cards.forEach((card) => {
    card.addEventListener('click', () => {
      cards.forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedPreset = card.dataset.preset;
      selName.textContent = LABELS[selectedPreset] || selectedPreset;
      applyBtn.disabled = false;
    });
  });

  applyBtn.addEventListener('click', () => {
    if (!selectedPreset) return;
    window.rni.pickerApply(selectedPreset);
  });

  const doCancel = () => window.rni.pickerCancel();
  cancelBtn.addEventListener('click', doCancel);
  closeBtn.addEventListener('click', doCancel);

  // Keyboard: Enter to apply, Escape to cancel
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') doCancel();
    if (e.key === 'Enter' && !applyBtn.disabled) applyBtn.click();
  });

  // Keep the picker's theme in sync if it changes while this window is open
  // (e.g. user flips the theme toggle in the main window, or the OS theme
  // changes while "System" is selected).
  if (window.rni && typeof window.rni.on === 'function') {
    window.rni.on('theme:system-changed', ({ isDark }) => {
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    });
  }
});