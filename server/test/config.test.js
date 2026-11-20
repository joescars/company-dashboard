import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, publicConfig, SOURCES } from '../src/lib/config.js';

/** Build a fake env for a test, clearing all known keys first. */
const KEYS = [
  'COMPANY_NAME', 'COMPANY_SITE_URL', 'COMPANY_LOGO_URL', 'COMPANY_THEME_ACCENT',
  'SOURCES_ENABLED', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
  'AZURE_SUBSCRIPTION_ID', 'AZURE_RESOURCE_IDS', 'OPENROUTER_API_KEY',
  'OPENROUTER_MANAGEMENT_KEY', 'GSC_SITE_URL', 'GA4_PROPERTY_ID', 'ADSENSE_ACCOUNT_ID',
  'SIMPLE_ANALYTICS_SITE', 'SIMPLE_ANALYTICS_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64',
  'COMPANY_CONFIG_PATH',
];

function withEnv(vars, fn) {
  const saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('defaults to a generic company name with no sources enabled', () => {
  withEnv({}, () => {
    const config = loadConfig({ configPath: '/nonexistent/company.json' });
    assert.equal(config.companyName, 'Company Dashboard');
    for (const key of SOURCES) {
      assert.equal(config.sources[key].enabled, false, `${key} must start disabled`);
    }
  });
});

test('company name comes from the environment', () => {
  withEnv({ COMPANY_NAME: 'Acme Widgets' }, () => {
    const config = loadConfig({ configPath: '/nonexistent/company.json' });
    assert.equal(config.companyName, 'Acme Widgets');
  });
});

test('a source stays disabled without credentials', () => {
  withEnv(
    { AZURE_SUBSCRIPTION_ID: 'sub-1', AZURE_RESOURCE_IDS: 'res-a,res-b' },
    () => {
      const config = loadConfig({ configPath: '/nonexistent/company.json' });
      assert.equal(
        config.sources.azure.enabled,
        false,
        'identifiers alone must not enable a source',
      );
    },
  );
});

test('azure enables only with credentials and identifiers', () => {
  withEnv(
    {
      AZURE_TENANT_ID: 't',
      AZURE_CLIENT_ID: 'c',
      AZURE_CLIENT_SECRET: 's',
      AZURE_SUBSCRIPTION_ID: 'sub-1',
      AZURE_RESOURCE_IDS: 'res-a',
    },
    () => {
      const config = loadConfig({ configPath: '/nonexistent/company.json' });
      assert.equal(config.sources.azure.enabled, true);
      assert.deepEqual(config.sources.azure.config.resourceIds, ['res-a']);
    },
  );
});

test('openrouter needs only its api key', () => {
  withEnv({ OPENROUTER_API_KEY: 'sk-or-test' }, () => {
    const config = loadConfig({ configPath: '/nonexistent/company.json' });
    assert.equal(config.sources.openrouter.enabled, true);
  });
});

test('google sources share one service account', () => {
  withEnv(
    {
      GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: 'e30=',
      GSC_SITE_URL: 'sc-domain:example.com',
      GA4_PROPERTY_ID: '123456',
      ADSENSE_ACCOUNT_ID: 'pub-1',
    },
    () => {
      const config = loadConfig({ configPath: '/nonexistent/company.json' });
      assert.equal(config.sources.searchConsole.enabled, true);
      assert.equal(config.sources.ga4.enabled, true);
      assert.equal(config.sources.adsense.enabled, true);
      assert.equal(config.sources.simpleAnalytics.enabled, false);
    },
  );
});

test('SOURCES_ENABLED narrows but never bypasses credentials', () => {
  withEnv(
    { SOURCES_ENABLED: 'azure,openrouter', OPENROUTER_API_KEY: 'sk-or-test' },
    () => {
      const config = loadConfig({ configPath: '/nonexistent/company.json' });
      assert.equal(config.sources.azure.enabled, false, 'listed but uncredentialed');
      assert.equal(config.sources.openrouter.enabled, true);
    },
  );
});

test('publicConfig exposes no identifiers or secrets', () => {
  withEnv(
    {
      COMPANY_NAME: 'Acme',
      AZURE_TENANT_ID: 't',
      AZURE_CLIENT_ID: 'c',
      AZURE_CLIENT_SECRET: 's',
      AZURE_SUBSCRIPTION_ID: 'sub-secret-ish',
      AZURE_RESOURCE_IDS: 'res-a',
    },
    () => {
      const config = loadConfig({ configPath: '/nonexistent/company.json' });
      const safe = publicConfig(config);
      const serialized = JSON.stringify(safe);
      assert.equal(safe.companyName, 'Acme');
      assert.equal(safe.sources.azure.enabled, true);
      assert.ok(!serialized.includes('sub-secret-ish'), 'subscription id must not leak');
      assert.ok(!serialized.includes('res-a'), 'resource ids must not leak');
      assert.equal('config' in safe.sources.azure, false);
    },
  );
});