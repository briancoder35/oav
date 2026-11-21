const { catalogs: epornerCatalogs } = require('./eporner');
const xhamsterCatalogs = require('./xhamster');
const porntrexCatalogs = require('./porntrex');
const xvideosCatalog = require('./xvideos.json');
const xnxxCatalog = require('./xnxx.json');
const javtifulCatalog = require('./javtiful.json');
const javguruCatalog = require('./javguru.json');

const catalogNames = [
  'eporner',
  'xhamster',
  'porntrex',
  'xvideos',
  'xnxx',
  'javtiful',
  'javguru',
];

const catalogs = [
  ...epornerCatalogs,
  ...xhamsterCatalogs,
  porntrexCatalogs,
  xvideosCatalog,
  xnxxCatalog,
  javtifulCatalog,
  javguruCatalog,
];

const addonEnabled = (id) => {
  return getActiveProvider(id) !== null;
};

const getActiveProvider = (id) => {
  for (const name of catalogNames) {
    if (id.includes(name)) {
      return name;
    }
  }
  return null;
};

module.exports = {
  catalogs,
  catalogNames,
  addonEnabled,
  getActiveProvider,
};
