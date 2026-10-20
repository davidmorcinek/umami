/* eslint-disable no-console */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import chalk from 'chalk';
import { PrismaClient } from '../generated/prisma/client.js';

const MIN_VERSION = '9.4.0';
const MIN_VERSION_NUM = 90400;

if (process.env.SKIP_DB_CHECK) {
  console.log('Skipping database check.');
  process.exit(0);
}

const url = new URL(process.env.DATABASE_URL);

// m9: verified TLS when DATABASE_CA_CERT (PEM) is set – same rules as getPoolConfig in src/lib/prisma.ts
const caCert = process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n');
const SSL_PARAMS = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert'];

function getPoolConfig() {
  if (!caCert) {
    return { connectionString: url.toString() };
  }

  const poolUrl = new URL(url);
  for (const key of SSL_PARAMS) {
    poolUrl.searchParams.delete(key);
  }

  return { connectionString: poolUrl.toString(), ssl: { ca: caCert, rejectUnauthorized: true } };
}

const adapter = new PrismaPg(getPoolConfig(), { schema: url.searchParams.get('schema') });

const prisma = new PrismaClient({ adapter });

function success(msg) {
  console.log(chalk.greenBright(`✓ ${msg}`));
}

function error(msg) {
  console.log(chalk.redBright(`✗ ${msg}`));
}

async function checkEnv() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not defined.');
  } else {
    success('DATABASE_URL is defined.');
  }

  if (process.env.REDIS_URL) {
    success('REDIS_URL is defined.');
  }
}

async function checkConnection() {
  try {
    await prisma.$connect();

    success('Database connection successful.');
  } catch (e) {
    throw new Error(`Unable to connect to the database: ${e.message}`);
  }
}

async function checkDatabaseVersion() {
  const query = await prisma.$queryRaw`select current_setting('server_version_num') as version_num`;
  const version = Number(query[0]?.version_num);

  if (!Number.isFinite(version)) {
    throw new Error('Unable to determine database version.');
  }

  if (version < MIN_VERSION_NUM) {
    throw new Error(
      `Database version is not compatible. Please upgrade to ${MIN_VERSION} or greater.`,
    );
  }

  success('Database version check successful.');
}

async function applyMigration() {
  if (!process.env.SKIP_DB_MIGRATION) {
    let directUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

    // m9: the Prisma schema engine takes the CA as a file and verifies it with sslaccept=strict
    if (caCert) {
      const certPath = path.join(os.tmpdir(), 'umami-db-ca.crt');
      fs.writeFileSync(certPath, caCert);

      const migrateUrl = new URL(directUrl);
      for (const key of SSL_PARAMS) {
        migrateUrl.searchParams.delete(key);
      }
      migrateUrl.searchParams.set('sslmode', 'require');
      migrateUrl.searchParams.set('sslcert', certPath);
      migrateUrl.searchParams.set('sslaccept', 'strict');
      directUrl = migrateUrl.toString();
    }
    console.log(
      execSync('prisma migrate deploy', {
        env: { ...process.env, DATABASE_URL: directUrl },
      }).toString(),
    );

    success('Database is up to date.');
  }
}

(async () => {
  let err = false;
  for (const fn of [checkEnv, checkConnection, checkDatabaseVersion, applyMigration]) {
    try {
      await fn();
    } catch (e) {
      error(e.message);
      err = true;
    } finally {
      if (err) {
        process.exit(1);
      }
    }
  }
})();
