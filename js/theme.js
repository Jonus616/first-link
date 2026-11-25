// Runs before the page paints so a saved Light or Dark choice never flashes
// the other theme. "os" means follow the device setting.
(function () {
  var choice = 'os';
  try {
    var saved = localStorage.getItem('first-link-theme');
    if (saved === 'day' || saved === 'night' || saved === 'os') choice = saved;
  } catch (err) { /* storage blocked: follow the device */ }
  document.documentElement.dataset.theme = choice;
})();
