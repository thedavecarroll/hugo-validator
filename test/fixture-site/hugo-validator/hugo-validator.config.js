// Config for the sample site used by hugo-validator's end-to-end tests
module.exports = {
  siteUrl: 'https://fixture.test/',
  portsToKill: [], // tests must never kill processes on the developer's machine
  cssPattern: 'assets/scss/**/*.scss',
  skipPaths: ['/sitemap.xml'],
  responsive: {
    wrapperSelector: '.page-wrapper',
    spotCheckPages: ['/', '/posts/', '/about/'],
  },
  interaction: {
    navSelector: '.site-nav a',
  },
  accessibility: {
    shards: 2,
  },
  testServerPort: 38917,
  testWorkers: 4,
};
