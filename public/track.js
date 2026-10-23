/* First-party pageview beacon. No cookies, no third party. */
(function () {
  var API = window.MTB5_API || (
    (location.hostname.endsWith('.workers.dev') || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? location.origin
      : 'https://mt5-analyzer.dhashan.workers.dev'
  );
  try {
    var body = JSON.stringify({ name: 'view', path: location.pathname });
    if (navigator.sendBeacon) navigator.sendBeacon(API + '/api/event', body);
  } catch (e) {}
})();
